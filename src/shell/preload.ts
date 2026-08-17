import { contextBridge, ipcRenderer } from 'electron'
import type { RunConfig, TabInfo } from './ipc-types.ts'

contextBridge.exposeInMainWorld('shell', {
  startRun: (cfg: RunConfig) => ipcRenderer.invoke('run:start', cfg),
  decideGate: (id: number, allow: boolean) => ipcRenderer.invoke('gate:decide', { id, allow }),
  stop: () => ipcRenderer.invoke('run:stop'),
  goUrl: (url: string) => ipcRenderer.invoke('nav:go', url),
  goBack: () => ipcRenderer.invoke('nav:back'),
  goForward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  createTab: (url?: string) => ipcRenderer.invoke('tabs:create', { url }),
  closeTab: (id: number) => ipcRenderer.invoke('tabs:close', { id }),
  activateTab: (id: number) => ipcRenderer.invoke('tabs:activate', { id }),
  togglePane: (open: boolean) => ipcRenderer.invoke('pane:toggle', { open }),
  onLog: (cb: (line: string) => void) => ipcRenderer.on('run:log', (_e, line: string) => cb(line)),
  onGate: (cb: (g: { id: number; tool: string; summary: string; reason: string }) => void) =>
    ipcRenderer.on('run:gate', (_e, g) => cb(g)),
  onDone: (cb: (r: { answer: string; steps: number; totalTokens: number; gated: number; denied: number }) => void) =>
    ipcRenderer.on('run:done', (_e, r) => cb(r)),
  onTab: (cb: (t: TabInfo) => void) => ipcRenderer.on('tab:info', (_e, t: TabInfo) => cb(t)),
  onTabRemoved: (cb: (id: number) => void) => ipcRenderer.on('tab:removed', (_e, id: number) => cb(id)),
  onNavState: (cb: (s: { canBack: boolean; canForward: boolean }) => void) =>
    ipcRenderer.on('nav:state', (_e, s) => cb(s)),
})