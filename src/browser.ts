import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME_PATH = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROFILES_DIR = join(APP_ROOT, 'profiles')

export interface LaunchedChrome {
  proc: ChildProcess
  port: number
  profileDir: string
}

export function launchChrome(opts: { port?: number; profile?: string } = {}): LaunchedChrome {
  const port = opts.port ?? 9222
  const profileDir = join(PROFILES_DIR, opts.profile ?? 'default')
  mkdirSync(profileDir, { recursive: true })

  const proc = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Keep the window on-screen and interactive: when our own window fully
      // covers Chrome, occlusion throttling stalls CDP input events (clicks
      // silently vanish). These flags disable background/occlusion throttling.
      '--window-position=0,0',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      'about:blank',
    ],
    { stdio: 'ignore' }
  )
  return { proc, port, profileDir }
}

// Fresh profiles do first-run setup and can be slow; poll until the port answers.
export async function waitForPort(port: number, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Chrome never opened port ${port} (waited ${tries * 0.5}s)`)
}

// taskkill /T kills the whole tree (renderers, GPU process, ...)
export function killChrome(proc: ChildProcess): void {
  if (!proc.pid || proc.killed) return
  spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
}

export interface TargetInfo {
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

export async function listTargets(port: number): Promise<TargetInfo[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return (await res.json()) as TargetInfo[]
}

type CdpMessage = { id?: number; result?: any; error?: { message: string } }

// The whole control plane from lesson 4, as a class.
export class CDP {
  private ws: WebSocket
  private nextId = 0
  private pending = new Map<number, (msg: CdpMessage) => void>()

  private constructor(ws: WebSocket) {
    this.ws = ws
  }

  // Discover a page target over HTTP, then open the WebSocket door.
  static async connect(port: number, targetType = 'page'): Promise<CDP> {
    const targets = await listTargets(port)
    const target = targets.find((t) => t.type === targetType && !t.url.startsWith('chrome://'))
    if (!target?.webSocketDebuggerUrl) throw new Error(`No ${targetType} target found on port ${port}`)

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const cdp = new CDP(ws)

    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as CdpMessage
      if (msg.id && cdp.pending.has(msg.id)) {
        cdp.pending.get(msg.id)!(msg)
        cdp.pending.delete(msg.id)
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('WebSocket connection failed'))
    })
    return cdp
  }

  // JSON-RPC: {id, method, params} in, matching {id, result} out.
  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    return new Promise((resolve) => {
      const id = ++this.nextId
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  // Run JS inside the page — the agent's direct line to the DOM.
  // awaitPromise: expressions may return promises (e.g. fonts.ready, rAF waits).
  async evaluate(expression: string): Promise<unknown> {
    const msg = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (msg.result?.exceptionDetails) {
      throw new Error(`evaluate failed: ${msg.result.exceptionDetails.text}`)
    }
    return msg.result?.result?.value
  }

  // A picture of the page — the seed of vision-based perception.
  async screenshot(outPath: string): Promise<void> {
    await this.send('Page.enable')
    const msg = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(outPath, Buffer.from(msg.result.data, 'base64'))
  }

  close(): void {
    this.ws.close()
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
    await this.evaluate(`(() => { window.__agent_mousedown = 0; document.addEventListener('mousedown', () => { window.__agent_mousedown++ }, true) })()`)

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
  async type(selector: string, text: string): Promise<boolean> {
    await this.send('Page.bringToFront')
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

  // Press a key (Enter to submit, Tab, ...).
  async pressKey(key: string): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key })
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