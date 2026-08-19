export interface RunConfig {
  goal: string
  mode: 'ask' | 'allow' | 'deny'
  domains: string[]
  maxMs: number
  carry: boolean
  memory: boolean
}

export interface TabInfo {
  id: number
  label: string
  url: string
  favicon: string
  active: boolean
  closable: boolean
}