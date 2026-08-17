// shell/preload.ts — the only bridge between the panel and the main process.
// contextIsolation is on; the panel talks to this tiny typed surface only.
import { contextBridge, ipcRenderer } from 'electron'

export interface RunConfig {
  goal: string
  mode: 'ask' | 'allow' | 'deny'
  domains: string[]
  maxMs: number
}

contextBridge.exposeInMainWorld('shell', {
  startRun: (cfg: RunConfig) => ipcRenderer.invoke('run:start', cfg),
  decideGate: (id: number, allow: boolean) => ipcRenderer.invoke('gate:decide', { id, allow }),
  stop: () => ipcRenderer.invoke('run:stop'),
  goUrl: (url: string) => ipcRenderer.invoke('nav:go', url),
  onLog: (cb: (line: string) => void) => ipcRenderer.on('run:log', (_e, line: string) => cb(line)),
  onGate: (cb: (g: { id: number; tool: string; summary: string; reason: string }) => void) =>
    ipcRenderer.on('run:gate', (_e, g) => cb(g)),
  onDone: (cb: (r: { answer: string; steps: number; totalTokens: number; gated: number; denied: number }) => void) =>
    ipcRenderer.on('run:done', (_e, r) => cb(r)),
  onUrl: (cb: (url: string) => void) => ipcRenderer.on('page:url', (_e, url: string) => cb(url)),
})
