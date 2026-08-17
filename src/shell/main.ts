// shell/main.ts — Phase 5: the desktop shell (lesson 6 §2).
// Main process = the brain: owns the window, the WebContentsView (the page),
// the agent loop, and the approval gate. The renderer (panel.html) is only UI.
//
// Layout: a 320px agent panel on the left (the chrome), the page view on the
// right. The view overlays the renderer, so the panel's HTML must stay inside
// the left 320px column.
import { app, BrowserWindow, WebContentsView, ipcMain, session } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CDP } from '../browser.ts'
import { AuditLog, allowAll, denyAll, type Policy, type SensitiveAction } from '../safety.ts'
import { DebuggerCommand } from './electron-transport.ts'

const PANEL_W = 320
const GATE_TIMEOUT_MS = 60_000

// Electron does not pass --env-file to its bundled Node, so load .env by hand
// BEFORE anything that reads it (llm.ts reads the key at import time — hence
// the dynamic import of the agent module below).
function loadEnv(): void {
  const f = join(process.cwd(), '.env')
  if (!existsSync(f)) return
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}

let win: BrowserWindow | null = null
let view: WebContentsView | null = null
let cdp: CDP | null = null
let running = false
let cancelled = false
let gateSeq = 0
const pendingGates = new Map<number, (allowed: boolean) => void>()

const sendToPanel = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// The agent streams step lines through console.log — tee them to the panel.
// console.log is restored when the run ends.
function teeLog(): () => void {
  const orig = console.log
  console.log = (...args: unknown[]) => {
    orig(...args)
    sendToPanel('run:log', args.map(String).join(' '))
  }
  return () => {
    console.log = orig
  }
}

// The Phase-5 approval card: a gate policy that pauses the loop and asks the
// user in the window. Silence = deny (an unattended run can never approve
// itself), and a denial flows back into the loop as "user refused".
function cardPolicy(): Policy {
  return {
    decide: (a: SensitiveAction) =>
      new Promise<boolean>((resolve) => {
        const id = ++gateSeq
        const timer = setTimeout(() => {
          pendingGates.delete(id)
          resolve(false)
        }, GATE_TIMEOUT_MS)
        pendingGates.set(id, (allowed) => {
          clearTimeout(timer)
          resolve(allowed)
        })
        sendToPanel('run:gate', { id, tool: a.tool, summary: a.summary, why: a.why, reason: a.why.join(', ') })
      }),
  }
}

const layout = (): void => {
  if (!win || !view) return
  const [w, h] = win.getContentSize()
  view.setBounds({ x: PANEL_W, y: 0, width: Math.max(w - PANEL_W, 0), height: h })
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'agentic-browser-comet',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: join(__dirname, 'shell-preload.cjs'),
    },
  })
  await win.loadFile(join(__dirname, 'panel', 'panel.html'))

  // The page — an isolated agent profile (rail 5): its cookies live in a
  // session partition of their own, never the browser's real profile.
  view = new WebContentsView({
    webPreferences: { session: session.fromPartition('persist:agent') },
  })
  win.contentView.addChildView(view)
  layout()
  win.on('resize', layout)

  view.webContents.on('did-navigate', (_e, url) => sendToPanel('page:url', url))
  view.webContents.on('did-navigate-in-page', (_e, url) => sendToPanel('page:url', url))
  // Pop-ups don't get their own tab yet — open in the same view.
  view.webContents.setWindowOpenHandler(({ url }) => {
    view?.webContents.loadURL(url)
    return { action: 'deny' }
  })

  cdp = CDP.attach(new DebuggerCommand(view.webContents))
  view.webContents.loadURL('https://books.toscrape.com')

  // Smoke/CI mode: SHELL_SMOKE_GOAL="goal" npm run shell starts a run with no
  // GUI interaction. The panel sees the same events; the terminal sees the log.
  const smokeGoal = process.env.SHELL_SMOKE_GOAL
  if (smokeGoal) {
    view.webContents.once('did-finish-load', () => {
      void startRun({ goal: smokeGoal, mode: process.env.SHELL_SMOKE_MODE === 'ask' ? 'ask' : 'deny', domains: [], maxMs: 240_000 })
    })
  }
}

export interface RunConfig {
  goal: string
  mode: 'ask' | 'allow' | 'deny'
  domains: string[]
  maxMs: number
}

async function startRun(cfg: RunConfig): Promise<{ ok: boolean; error?: string }> {
  if (running) return { ok: false, error: 'a run is already active' }
  if (!cdp) return { ok: false, error: 'browser not ready' }
  running = true
  cancelled = false
  const restore = teeLog()
  try {
    // Imported late: this chain reads process.env at module scope.
    const { runAgent } = await import('../agent.ts')
    const policy = cfg.mode === 'ask' ? cardPolicy() : cfg.mode === 'allow' ? allowAll : denyAll
    const audit = new AuditLog(join(__dirname, '..', 'logs', 'audit.jsonl'))
    const domains = cfg.domains.filter(Boolean)
    console.log(`GOAL: ${cfg.goal}`)
    if (domains.length) console.log(`SCOPE: ${domains.join(', ')} (navigation outside is denied)`)
    console.log(`POLICY: ${cfg.mode === 'ask' ? 'ask (approval cards)' : cfg.mode === 'allow' ? 'allow-all' : 'deny-all (safe default)'}\n`)
    const run = await runAgent(cdp, cfg.goal, {
      policy,
      allowedDomains: domains,
      audit,
      timeBudgetMs: cfg.maxMs || 5 * 60_000,
      isCancelled: () => cancelled,
    })
    console.log(`\n=== RESULT (${run.steps} steps, ~${run.totalTokens.toLocaleString()} tokens) ===\n${run.answer}`)
    console.log(`\nSafety: ${run.gated} gated, ${run.denied} denied — full audit in logs/audit.jsonl`)
    sendToPanel('run:done', run)
    return { ok: true }
  } finally {
    restore()
    running = false
  }
}

ipcMain.handle('run:start', async (_e, cfg: RunConfig) => startRun(cfg))

ipcMain.handle('gate:decide', (_e, payload: { id: number; allow: boolean }) => {
  pendingGates.get(payload.id)?.(payload.allow)
  pendingGates.delete(payload.id)
})

ipcMain.handle('run:stop', () => {
  cancelled = true
})

ipcMain.handle('nav:go', (_e, url: string) => {
  view?.webContents.loadURL(url)
})

app.whenReady().then(async () => {
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
