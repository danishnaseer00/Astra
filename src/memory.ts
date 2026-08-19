import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export interface MemoryEntry {
  ts: string
  goal: string
  facts: string[]
  answer: string
}

const MAX_ENTRIES_PER_DOMAIN = 5
const MAX_DOMAINS = 50

export class FactsStore {
  private readonly file: string
  private data: { domains: Record<string, MemoryEntry[]> }

  constructor(file: string) {
    this.file = file
    this.data = { domains: {} }
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { domains?: Record<string, MemoryEntry[]> }
        this.data = { domains: raw.domains ?? {} }
      }
    } catch {
     
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  remember(domain: string, goal: string, facts: string[], answer: string): void {
    const d = domain.toLowerCase()
    if (!/^[a-z0-9.-]+$/.test(d) || d.length > 100) return
    const entries = this.data.domains[d] ?? []
    entries.push({ ts: new Date().toISOString(), goal: goal.slice(0, 200), facts: facts.slice(0, 8), answer: answer.slice(0, 500) })
    if (entries.length > MAX_ENTRIES_PER_DOMAIN) entries.splice(0, entries.length - MAX_ENTRIES_PER_DOMAIN)
    this.data.domains[d] = entries
  
    const keys = Object.keys(this.data.domains)
    if (keys.length > MAX_DOMAINS) {
      const drop = keys.slice(0, keys.length - MAX_DOMAINS)
      for (const k of drop) delete this.data.domains[k]
    }
    this.save()
  }


  recallForDomains(domains: string[]): string {
    const blocks: string[] = []
    for (const d of domains) {
      const entries = this.data.domains[d.toLowerCase()] ?? []
      if (entries.length === 0) continue
      const tail = entries.slice(-3).map((e) => `- goal: ${e.goal}\n  answer: ${e.answer}`).join('\n')
      blocks.push(`${d}:\n${tail}`)
    }
    if (blocks.length === 0) return ''
    return 'KNOWN FACTS FROM PREVIOUS RUNS (persistent memory — trust only if still true, re-verify when cheap):\n' + blocks.join('\n')
  }
}

export function extractDomains(text: string): string[] {
  const out = new Set<string>()
  const urlRe = /https?:\/\/([a-z0-9.-]+)/gi
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(text))) out.add(m[1].toLowerCase())
  const bareRe = /\bon\s+([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi
  while ((m = bareRe.exec(text))) {
    const host = m[1].toLowerCase()
    if (!host.endsWith('.com') && !host.endsWith('.org') && !host.endsWith('.net') && !host.endsWith('.io') && !host.endsWith('.edu')) continue
    out.add(host)
  }
  return [...out]
}