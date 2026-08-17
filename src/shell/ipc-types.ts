// Shared IPC payload shapes for the shell. Both the main process (sender)
// and the preload bridge (consumer) must agree on these — one source of truth.
export interface RunConfig {
  goal: string
  mode: 'ask' | 'allow' | 'deny'
  domains: string[]
  maxMs: number
  carry: boolean
}

export interface TabInfo {
  id: number
  label: string
  url: string
  favicon: string
  active: boolean
  closable: boolean
}