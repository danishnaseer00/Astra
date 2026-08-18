import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME_PATH = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'

let APP_ROOT: string
try {
  APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
} catch {
  APP_ROOT = process.cwd()
}
const PROFILES_DIR = join(APP_ROOT, 'profiles')

export interface LaunchedChrome {
  proc: ChildProcess
  port: number
  profileDir: string
}

// A crashed previous run can leave a stale Chrome holding the port (and the
// profile lock). Probe for a free port so we never attach to a zombie instance
// or fight over a locked profile.
async function portInUse(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })
    return res.ok
  } catch {
    return false // nothing answering = free
  }
}

export async function launchChrome(opts: { port?: number; profile?: string } = {}): Promise<LaunchedChrome> {
  const requested = opts.port ?? 9222
  let port = requested
  while (port < requested + 10 && (await portInUse(port))) {
    console.log(`  (port ${port} already in use — trying ${port + 1})`)
    port++
  }
  // Use a distinct profile when the port was bumped: the stale Chrome on the
  // original port still holds the lock on its profile directory.
  const profileDir = join(PROFILES_DIR, port === requested ? (opts.profile ?? 'default') : `${opts.profile ?? 'default'}-${port}`)
  mkdirSync(profileDir, { recursive: true })

  const proc = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=0,0',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      'about:blank',
    ],
    { stdio: 'ignore' }
  )
  // A missing binary / permission failure surfaces here as an async 'error'
  // event — log it instead of crashing the process with an unhandled error.
  proc.on('error', (err) => console.error(`[chrome:spawn] ${err.message}`))
  return { proc, port, profileDir }
}


export async function waitForPort(port: number, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      // port not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Chrome never opened port ${port} (waited ${tries * 0.5}s)`)
}


export function killChrome(proc: ChildProcess): void {
  if (!proc.pid || proc.killed) return
  spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
}

export interface TargetInfo {
  id?: string
  title?: string
  active?: boolean
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

export async function listTargets(port: number): Promise<TargetInfo[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return (await res.json()) as TargetInfo[]
}

export type CdpMessage = { id?: number; result?: Record<string, unknown>; error?: { message: string } }

export interface CdpCommand {
  send(method: string, params: Record<string, unknown>): Promise<CdpMessage>
  close(): void
}

class WebSocketCommand implements CdpCommand {
  private nextId = 0
  private pending = new Map<number, (msg: CdpMessage) => void>()
  private ws: WebSocket
  private closed = false

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as CdpMessage
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg)
        this.pending.delete(msg.id)
      }
    }
    // A dead transport must fail in-flight commands LOUDLY, never hang them:
    // if Chrome dies or the socket drops mid-run, every pending command is
    // rejected instead of resolving never (which would freeze the agent loop).
    ws.onclose = () => this.failAll(new Error('CDP connection closed'))
    ws.onerror = () => this.failAll(new Error('CDP connection error'))
  }

  private failAll(err: Error): void {
    this.closed = true
    for (const resolve of this.pending.values()) resolve({ error: { message: err.message } })
    this.pending.clear()
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    if (this.closed) return Promise.resolve({ error: { message: 'CDP connection closed' } })
    return new Promise((resolve) => {
      const id = ++this.nextId
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.closed = true
    this.ws.close()
  }
}


export class CDP {
  private cmd: CdpCommand

  private constructor(cmd: CdpCommand) {
    this.cmd = cmd
  }

 
  static async connect(port: number, targetType = 'page'): Promise<CDP> {
    const targets = await listTargets(port)
    const target = targets.find((t) => t.type === targetType && !t.url.startsWith('chrome://'))
    if (!target?.webSocketDebuggerUrl) throw new Error(`No ${targetType} target found on port ${port}`)
    return CDP.connectTo(target.webSocketDebuggerUrl)
  }

  // The tab tools (Phase 7) attach to a specific target's socket by URL —
  // this is how switch_tab re-points the agent at another page.
  static async connectTo(wsUrl: string): Promise<CDP> {
    const ws = new WebSocket(wsUrl)
    const cdp = new CDP(new WebSocketCommand(ws))

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('WebSocket connection failed'))
    })
    return cdp
  }

  // The lesson-6 door: a transport over webContents.debugger from the shell.
  static attach(cmd: CdpCommand): CDP {
    return new CDP(cmd)
  }

  // JSON-RPC: {id, method, params} in, matching {id, result} out.
  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    return this.cmd.send(method, params)
  }

  close(): void {
    this.cmd.close()
  }

  // Run JS inside the page — the agent's direct line to the DOM.
  // awaitPromise: expressions may return promises (e.g. fonts.ready, rAF waits).
  async evaluate(expression: string): Promise<unknown> {
    const msg = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const detail = msg.result?.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
    if (detail) {
      const what = detail.exception?.description?.split('\n')[0] || detail.text || 'unknown'
      throw new Error(`evaluate failed: ${what}`)
    }
    return (msg.result?.result as { value?: unknown } | undefined)?.value
  }

  // In-memory screenshot: full viewport, or clipped to a region (the captcha
  // solver captures just the challenge iframe so the vision model sees the
  // puzzle, not the page around it). Returns raw base64 PNG.
  async screenshotBase64(clip?: { x: number; y: number; width: number; height: number }): Promise<string> {
    await this.send('Page.enable')
    const params: Record<string, unknown> = { format: 'png' }
    if (clip) params.clip = { ...clip, scale: 1 }
    const msg = await this.send('Page.captureScreenshot', params)
    const data = msg.result?.data as string | undefined
    if (!data) throw new Error('captureScreenshot returned no data')
    return data
  }

  // === Phase 1: the actor — real, trusted input events ===

  // Go somewhere, then wait for the page to finish loading AND settle.
  async navigate(url: string): Promise<void> {
    await this.send('Page.navigate', { url })
    await this.waitForLoad(url)
  }

  // readyState complete + rendering settled (fonts + two animation frames).
  // Right after a navigation the CDP input pipeline can silently drop mouse
  // events while the compositor has not produced a frame for the new document
  // (observed ~50% flake on fresh pages; clicks on settled pages always land).
  // Also fails loudly on server errors (5xx) instead of pretending the page
  // loaded: readyState reaches 'complete' on error pages too.
  async waitForLoad(url?: string): Promise<void> {
    await this.send('Page.bringToFront')
    let complete = false
    for (let i = 0; i < 60; i++) {
      try {
        if ((await this.evaluate('document.readyState')) === 'complete') {
          complete = true
          break
        }
      } catch {
        // execution context torn down mid-navigation; retry
      }
      await sleep(500)
    }
    if (!complete) throw new Error(`Page did not finish loading${url ? `: ${url}` : ''}`)
    try {
      const err = (await this.evaluate(
        `(() => {
          const t = document.title
          return /(5\\d\\d|internal server error|bad gateway|service temporarily unavailable)/i.test(t) ? t : null
        })()`
      )) as string | null
      if (err) throw new Error(`Page returned a server error: "${err}"`)
      // Font swaps shift layout; wait for them (bounded), then two frames
      // guarantee the compositor rendered this document at least once.
      await this.evaluate(
        `Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]).then(() =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`
      )
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Page returned a server error')) throw err
      // page replaced us mid-settle; the caller's next action re-verifies anyway
    }
  }

  // Find an element and click its center with trusted mouse events.
  // Trusted events (unlike element.click()) work through React/Vue/Angular.
  // Navigation-aware: if the target is a real link and the page does not
  // navigate within the grace window, retry the trusted dispatch once, then
  // fall back to a DOM click (anchor navigation works through el.click()
  // even when the CDP input pipeline drops trusted events).
  async click(selector: string): Promise<boolean> {
    await this.send('Page.bringToFront')
    const target = await this.elementCenter(selector)
    if (!target) return false
    const { x, y } = target
    const isNavAnchor = target.isNavAnchor

    const beforeUrl = await this.evaluate('location.href').catch(() => null)
    // One named listener per document, removed before re-adding: a fresh
    // anonymous listener per click would stack forever (leak + inflated
    // count that defeats the fired-detection below).
    await this.evaluate(`(() => {
      window.__agent_mousedown = 0
      if (window.__agent_mousedown_handler) document.removeEventListener('mousedown', window.__agent_mousedown_handler, true)
      window.__agent_mousedown_handler = () => { window.__agent_mousedown++ }
      document.addEventListener('mousedown', window.__agent_mousedown_handler, true)
    })()`)

    const dispatch = () =>
      this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }).then(() =>
        this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }).then(() =>
          this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
        )
      )
    // null = execution context torn down (the page navigated under us) = success
    const firedCount = async (): Promise<number | null> => {
      try {
        const v = (await this.evaluate('window.__agent_mousedown')) as unknown
        return typeof v === 'number' ? v : null
      } catch {
        return null
      }
    }
    const navigated = async (): Promise<boolean> => {
      const url = await this.evaluate('location.href').catch(() => null)
      return url !== null && url !== beforeUrl
    }
    const waitForNav = async (ms: number): Promise<boolean> => {
      for (let i = 0; i < ms / 100; i++) {
        if (await navigated()) return true
        await sleep(100)
      }
      return false
    }

    await dispatch()
    let fired = await firedCount()

    if (isNavAnchor && !(await navigated())) {
      // Dropped input or wrong target: retry the trusted dispatch once.
      await this.send('Page.bringToFront')
      await dispatch()
      fired = await firedCount()
    }
    if (isNavAnchor && !(await navigated())) {
      // Last resort: DOM click. It must not fire if we already navigated
      // (the evaluate would throw on a torn-down context — treat as success).
      try {
        await this.evaluate(
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)})
            if (el && el instanceof HTMLAnchorElement && el.href && !el.href.startsWith('javascript:')) {
              el.click()
              return true
            }
            return false
          })()`
        )
      } catch {
        // context gone = we navigated; waitForLoad below confirms
      }
      await waitForNav(1500)
    }

    if (isNavAnchor && (await navigated())) {
      await this.waitForLoad()
      return true
    }
    return fired === null || (typeof fired === 'number' && fired > 0)
  }

  // Focus an element and insert text the way a real keyboard would.
  // Composite inputs (date/color/range/number) ignore Input.insertText —
  // for those, set the value the way a script would and dispatch real events.
  async type(selector: string, text: string): Promise<boolean> {
    await this.send('Page.bringToFront')
    const mode = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        const t = (el.getAttribute?.('type') || '').toLowerCase()
        if (t === 'date' || t === 'color' || t === 'range' || t === 'number' || t === 'time' || t === 'datetime-local' || t === 'month' || t === 'week') return 'script'
        return 'keyboard'
      })()`
    )
    if (mode === null) return false
    if (mode === 'script') {
      const ok = await this.evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)})
          if (!el) return false
          el.focus()
          el.value = ${JSON.stringify(text)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        })()`
      )
      return ok === true
    }
    const focused = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        el.focus()
        return true
      })()`
    )
    if (!focused) return false
    await this.send('Input.insertText', { text })
    return true
  }

  // Form wizardry: pick option(s) in a <select> — value, not index, so the
  // model works from what the snapshot shows (option text) or a real value.
  async selectOption(selector: string, values: string[]): Promise<boolean> {
    await this.send('Page.bringToFront')
    const want = JSON.stringify(values)
    const ok = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!(el instanceof HTMLSelectElement)) return false
        const values = ${want}
        if (el.multiple) {
          for (const opt of el.options) opt.selected = values.includes(opt.value) || values.includes(opt.text.trim())
        } else {
          const opt = [...el.options].find((o) => values.includes(o.value) || values.includes(o.text.trim()))
          if (!opt) return false
          el.value = opt.value
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`
    )
    return ok === true
  }

  // Form wizardry: attach a local file to an <input type=file>. The browser
  // won't let JS invent a file path — but the agent OWNS the browser, so it
  // reads the file on disk and rebuilds it as a File object in the page.
  async uploadFile(selector: string, file: { name: string; type: string; base64: string }): Promise<boolean> {
    await this.send('Page.bringToFront')
    const ok = await this.evaluate(
      `(async () => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!(el instanceof HTMLInputElement) || el.type !== 'file') return false
        const bytes = Uint8Array.from(atob(${JSON.stringify(file.base64)}), (c) => c.charCodeAt(0))
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type)} }))
        el.files = dt.files
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`
    )
    return ok === true
  }

  // Scroll the page (negative deltaY scrolls up).
  async scroll(deltaY: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY })
  }

  // Find a point inside the element that actually receives the click.
  // Naive centers fail on wrapped inline text: the center can land in the
  // line-height gap between line boxes, where the element has no hit-testable
  // area (the click then fires on the parent). Probe a grid and verify.
  // Also reports whether the element is a real link — click() uses that to
  // verify navigation and choose fallbacks.
  private async elementCenter(selector: string): Promise<{ x: number; y: number; isNavAnchor: boolean } | null> {
    const point = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return null
        const points = [
          [r.x + r.width / 2, r.y + r.height / 2],
          [r.x + 5, r.y + 5],
          [r.x + r.width - 5, r.y + 5],
          [r.x + 5, r.y + r.height - 5],
          [r.x + r.width - 5, r.y + r.height - 5],
        ]
        for (const [px, py] of points) {
          const hit = document.elementFromPoint(px, py)
          if (hit && (hit === el || el.contains(hit))) {
            const isNavAnchor = el instanceof HTMLAnchorElement && el.href && !el.href.startsWith('javascript:')
            return { x: px, y: py, isNavAnchor }
          }
        }
        const isNavAnchor = el instanceof HTMLAnchorElement && el.href && !el.href.startsWith('javascript:')
        return { x: points[0][0], y: points[0][1], isNavAnchor }
      })()`
    )
    return point as { x: number; y: number; isNavAnchor: boolean } | null
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// === Phase 7: tab tools ======================================================
// The agent used to live in exactly one tab; open_tab/switch_tab/close_tab
// give it a tab strip. The host abstracts "where tabs live": the CLI drives
// the debug port's /json/* HTTP API (Chrome's own tab management); the shell
// could implement a WebContentsView-backed host later.

export interface TabInfo {
  id: string
  title: string
  url: string
  active: boolean
}

export interface TabHost {
  list(): Promise<TabInfo[]>
  open(url: string): Promise<TabInfo>
  activate(id: string): Promise<CDP>
  close(id: string): Promise<TabInfo[]>
}

export class CliTabHost implements TabHost {
  private readonly port: number
  private activeId: string | null = null

  constructor(port: number) {
    this.port = port
  }

  private async pageTargets(): Promise<TargetInfo[]> {
    const targets = await listTargets(this.port)
    return targets.filter((t) => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://'))
  }

  private async infoFor(t: TargetInfo): Promise<TabInfo> {
    // Chrome reports the real foreground tab; once the agent itself opens or
    // activates a tab, its choice wins (the driven page may not be foreground).
    const active = this.activeId !== null ? t.id === this.activeId : !!t.active
    return { id: t.id ?? '', title: t.title || '(untitled)', url: t.url, active }
  }

  async list(): Promise<TabInfo[]> {
    const targets = await this.pageTargets()
    // Keep the active tab honest even if it closed under us.
    if (this.activeId && !targets.some((t) => t.id === this.activeId)) this.activeId = null
    // Chrome does not report the foreground tab in /json/list; adopt the sole
    // tab as active when we have no tracking state (fresh browser).
    if (this.activeId === null && targets.length === 1) this.activeId = targets[0].id ?? null
    return Promise.all(targets.map((t) => this.infoFor(t)))
  }

  async open(url: string): Promise<TabInfo> {
    // Chrome's own "new tab" endpoint: PUT /json/new?<url> returns the target.
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    if (!res.ok) throw new Error(`failed to open tab (${res.status})`)
    const t = (await res.json()) as TargetInfo
    this.activeId = t.id ?? null
    return this.infoFor(t)
  }

  // Re-point the agent at another tab. Returns the fresh CDP connection.
  async activate(id: string): Promise<CDP> {
    const target = (await this.pageTargets()).find((t) => t.id === id)
    if (!target?.webSocketDebuggerUrl) throw new Error(`tab ${id} not found`)
    this.activeId = id
    return CDP.connectTo(target.webSocketDebuggerUrl)
  }

  async close(id: string): Promise<TabInfo[]> {
    await fetch(`http://127.0.0.1:${this.port}/json/close/${id}`).catch(() => {})
    const rest = await this.list()
    if (this.activeId === id) {
      this.activeId = null
      if (rest.length === 0) {
        // Closed the last tab — the agent must have a page to act on.
        await this.open('about:blank')
        return this.list()
      }
    }
    return this.list()
  }
}