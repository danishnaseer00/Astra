import { app, BrowserWindow, WebContentsView, ipcMain, session } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CDP } from '../browser.ts'
import { AuditLog, allowAll, denyAll, type Policy, type SensitiveAction } from '../safety.ts'
import { FactsStore } from '../memory.ts'
import { DebuggerCommand } from './electron-transport.ts'
import type { RunConfig, TabInfo } from './ipc-types.ts'

const OMNIBOX_H = 48
const TAB_STRIP_H = 34
const CHROME_H = OMNIBOX_H + TAB_STRIP_H
const PANE_W = 340
const GATE_TIMEOUT_MS = 60_000

function loadEnv(): void {
  const f = join(process.cwd(), '.env')
  if (!existsSync(f)) return
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || m[1] in process.env) continue
    let value = m[2].trim()
   
    if (!value.startsWith('"') && !value.startsWith("'")) value = value.replace(/\s+#.*$/, '')

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[m[1]] = value
  }
}

loadEnv()

interface Tab {
  id: number
  wc: WebContentsView
  label: string
  url: string
  favicon: string
  closable: boolean
}

let win: BrowserWindow | null = null
let tabs: Tab[] = []
let tabSeq = 0
let agentTab: Tab | null = null
let activeTabId = 0
let agentCdp: CDP | null = null
let running = false
let cancelled = false
let gateSeq = 0
let paneOpen = true
const pendingGates = new Map<number, (allowed: boolean) => void>()

const sendToPanel = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const tabInfo = (t: Tab): TabInfo => ({
  id: t.id,
  label: t.label,
  url: t.url,
  favicon: t.favicon,
  active: t.id === activeTabId,
  closable: t.closable,
})

const sendNavState = (): void => {
  const t = tabs.find((x) => x.id === activeTabId)
  sendToPanel('nav:state', {
    canBack: t?.wc.webContents.navigationHistory.canGoBack() ?? false,
    canForward: t?.wc.webContents.navigationHistory.canGoForward() ?? false,
  })
}

const broadcastTab = (t: Tab): void => sendToPanel('tab:info', tabInfo(t))

const resetView = (): void => {
  const v = agentTab?.wc.webContents
  if (v && !v.isDestroyed()) void v.loadURL('about:blank')
  if (lastSearchTabId !== null) {
    closeTab(lastSearchTabId)
    lastSearchTabId = null
  }
}

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
  if (!win) return
  const [w, h] = win.getContentSize()
  const cw = Math.max(w - (paneOpen ? PANE_W : 0), 0)
  const ch = Math.max(h - CHROME_H, 0)
  for (const t of tabs) t.wc.setBounds({ x: 0, y: CHROME_H, width: cw, height: ch })
}

const createTab = (url?: string, label = 'New tab', opts: { activate?: boolean; closable?: boolean; agent?: boolean } = {}): Tab => {
  const { activate = true, closable = true, agent = false } = opts

  const partition = agent ? 'persist:agent' : 'persist:user'
  const wc = new WebContentsView({
    webPreferences: { session: session.fromPartition(partition) },
  })
  const t: Tab = { id: ++tabSeq, wc, label, url: url ?? '', favicon: '', closable }
  wc.webContents.on('did-navigate', (_e, u) => {
    t.url = u
    broadcastTab(t)
    if (t.id === activeTabId) sendNavState()
  })
  wc.webContents.on('did-navigate-in-page', (_e, u) => {
    t.url = u
    broadcastTab(t)
    if (t.id === activeTabId) sendNavState()
  })
  wc.webContents.on('page-title-updated', (_e, title) => {
    if (t.closable) {
      t.label = title.slice(0, 26) || 'New tab'
      broadcastTab(t)
    }
  })
  wc.webContents.on('page-favicon-updated', (_e, favicons) => {
    t.favicon = favicons[0] ?? ''
    broadcastTab(t)
  })

  wc.webContents.setWindowOpenHandler(({ url: u }) => {
    void wc.webContents.loadURL(u)
    return { action: 'deny' }
  })
  win?.contentView.addChildView(wc)
  tabs.push(t)
  broadcastTab(t)
  layout()
  if (activate) {
    setActiveTab(t.id)
  } else {

    const a = tabs.find((x) => x.id === activeTabId)
    if (a && win) {
      win.contentView.addChildView(a.wc)
      layout()
    }
  }
  if (url) void wc.webContents.loadURL(url)
  return t
}

const setActiveTab = (id: number): void => {
  activeTabId = id
  const t = tabs.find((x) => x.id === id)
  if (t && win) {

    win.contentView.addChildView(t.wc)
    layout()
  }
  for (const x of tabs) broadcastTab(x)
  sendNavState()
}

const closeTab = (id: number): void => {
  const idx = tabs.findIndex((x) => x.id === id)
  if (idx === -1) return
  const t = tabs[idx]
  if (!t.closable || tabs.length <= 1) return // the agent tab and last tab stay
  tabs.splice(idx, 1)
  win?.contentView.removeChildView(t.wc)
  t.wc.webContents.close()
  sendToPanel('tab:removed', id)
  if (activeTabId === id) setActiveTab(tabs[tabs.length - 1].id)
  layout() // re-assert remaining views after removal
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
  const panelPath = join(__dirname, 'panel', 'panel.html')
  console.log(`[panel:path] ${panelPath} exists=${existsSync(panelPath)}`)
  await win.loadFile(panelPath)
  console.log(`[panel:loaded] title=${win.webContents.getTitle()}`)
  win.on('resize', layout)

  agentTab = createTab(pathToFileURL(join(__dirname, 'panel', 'ntp.html')).href, 'Agent', {
    activate: true,
    closable: false,
    agent: true,
  })
  agentCdp = CDP.attach(new DebuggerCommand(agentTab.wc.webContents))

  const smokeGoal = process.env.SHELL_SMOKE_GOAL
  if (smokeGoal) {
    win.hide() // no window popping up mid-run; logs go to the terminal
    agentTab.wc.webContents.once('did-finish-load', () => {
      void startRun({
        goal: smokeGoal,
        mode: process.env.SHELL_SMOKE_MODE === 'ask' ? 'ask' : 'deny',
        domains: [],
        maxMs: 600_000,
        carry: false,
        memory: false,
      })
    })
  }
}


let lastTurn: { goal: string; answer: string } | null = null

let lastSearchTabId: number | null = null
const searchMirror = (url: string, label?: string): void => {
  const existing = lastSearchTabId !== null ? tabs.find((x) => x.id === lastSearchTabId) : undefined
  if (existing) {
    void existing.wc.webContents.loadURL(url)
    return
  }
  lastSearchTabId = createTab(url, label ?? 'search', { activate: false, closable: true }).id
}

async function startRun(cfg: RunConfig): Promise<{ ok: boolean; error?: string }> {
  if (running) return { ok: false, error: 'a run is already active' }
  if (!agentCdp) return { ok: false, error: 'browser not ready' }
  running = true
  cancelled = false
  const restore = teeLog()
  try {
    const { runAgent } = await import('../agent.ts')
    const policy = cfg.mode === 'ask' ? cardPolicy() : cfg.mode === 'allow' ? allowAll : denyAll
    const audit = new AuditLog(join(__dirname, '..', 'logs', 'audit.jsonl'))
    const domains = cfg.domains.filter(Boolean)
    console.log(`GOAL: ${cfg.goal}`)
    if (domains.length) console.log(`SCOPE: ${domains.join(', ')} (navigation outside is denied)`)
    console.log(`POLICY: ${cfg.mode === 'ask' ? 'ask (approval cards)' : cfg.mode === 'allow' ? 'allow-all' : 'deny-all (safe default)'}\n`)

    const memory = cfg.memory ? new FactsStore(join(__dirname, '..', 'memory', 'facts.json')) : undefined
    const run = await runAgent(agentCdp, cfg.goal, {
      policy,
      allowedDomains: domains,
      audit,
      timeBudgetMs: cfg.maxMs || 5 * 60_000,
      isCancelled: () => cancelled,
      context: cfg.carry && lastTurn ? `goal: ${lastTurn.goal}\nanswer: ${lastTurn.answer}` : undefined,
      memory,

      onTabOpen: (url, label) => {
        console.log(`  (search mirrored into a background tab: ${label})`)
        searchMirror(url, label)
      },
    })
    console.log(`\n=== RESULT (${run.steps} steps, ~${run.totalTokens.toLocaleString()} tokens) ===\n${run.answer}`)
    console.log(`\nSafety: ${run.gated} gated, ${run.denied} denied — full audit in logs/audit.jsonl`)
    lastTurn = { goal: cfg.goal, answer: run.answer }
    sendToPanel('run:done', run)
    resetView()
    console.log('(run finished — page closed)')
    return { ok: true }
  } catch (err) {

    const why = err instanceof Error ? err.message : String(err)
    console.error(`run crashed: ${why}`)
    sendToPanel('run:done', { answer: `[run crashed: ${why}]`, steps: 0, totalTokens: 0, gated: 0, denied: 0 })
    resetView()
    return { ok: false, error: why }
  } finally {
    restore()
    running = false
    
    for (const id of [...pendingGates.keys()]) pendingGates.get(id)?.(false)
    pendingGates.clear()
  }
}

ipcMain.handle('run:start', async (_e, cfg: RunConfig) => startRun(cfg))

ipcMain.handle('gate:decide', (_e, payload: { id: number; allow: boolean }) => {
  pendingGates.get(payload.id)?.(payload.allow)
  pendingGates.delete(payload.id)
})

ipcMain.handle('run:stop', () => {
  cancelled = true
  for (const id of [...pendingGates.keys()]) pendingGates.get(id)?.(false)
  pendingGates.clear()
})

ipcMain.handle('nav:go', (_e, url: string) => {
  createTab(url, 'New tab', { activate: true, closable: true })
})

ipcMain.handle('nav:back', () => {
  tabs.find((x) => x.id === activeTabId)?.wc.webContents.goBack()
  sendNavState()
})

ipcMain.handle('nav:forward', () => {
  tabs.find((x) => x.id === activeTabId)?.wc.webContents.goForward()
  sendNavState()
})

ipcMain.handle('nav:reload', () => {
  tabs.find((x) => x.id === activeTabId)?.wc.webContents.reload()
})

ipcMain.handle('tabs:create', (_e, payload: { url?: string }) => {
  createTab(payload.url ?? undefined, 'New tab', { activate: true, closable: true })
})

ipcMain.handle('tabs:close', (_e, payload: { id: number }) => {
  closeTab(payload.id)
})

ipcMain.handle('tabs:activate', (_e, payload: { id: number }) => {
  setActiveTab(payload.id)
})

ipcMain.handle('pane:toggle', (_e, payload: { open: boolean }) => {
  paneOpen = payload.open
  layout()
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    await createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})