import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { CDP } from './browser.ts'
import { scrubPii } from './perceive.ts'

const BLOCKLIST: { label: string; re: RegExp }[] = [
  { label: 'pay', re: /pay|payment|checkout|purchase|buy-?now|\border\b|billing|\bcart\b/ },
  { label: 'login', re: /log-?in|sign-?in|signup|register|auth|password|credential/ },
  { label: 'send', re: /\bsend\b|submit|publish|post(?!ed)|share|comment|message/ },
  { label: 'delete', re: /\bdelete\b|\bremove\b|destroy|deactivate|close\s*account/ },
]

const DESTINATION_RAILS = BLOCKLIST.filter(({ label }) => label !== 'send')
const TYPE_RAILS = BLOCKLIST.filter(({ label }) => label !== 'send')

function matchesBlocklist(text: string, rails: typeof BLOCKLIST): string[] {
  const t = text.toLowerCase()
  const hits: string[] = []
  for (const { label, re } of rails) if (re.test(t)) hits.push(label)
  return [...new Set(hits)]
}

export const cleanUrl = (u: string): string => {
  const t = u.trim()
  const opens = (t.match(/\(/g) ?? []).length
  const closes = (t.match(/\)/g) ?? []).length
  return closes > opens ? t.replace(/[)\s]+$/, '') : t
}

export function inScope(url: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false 
  }
  return allowed.some((d) => host === d || host.endsWith('.' + d))
}

const WEB_SCHEME = /^https?:\/\//i

export function isWebUrl(url: string): boolean {
  return WEB_SCHEME.test(url)
}

const urlDomain = (url: string): string | undefined => {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

export function decodeRedirect(href: string): string {
  try {
    const u = new URL(href)
    if (u.hostname === 'www.bing.com') {
      const b64 = u.searchParams.get('u')
      if (b64) {
        const d = atob(b64.startsWith('a1') ? b64.slice(2) : b64)
        if (d.startsWith('http')) return d
      }
      const q = u.searchParams.get('q')
      if (q && WEB_SCHEME.test(q)) return q
    }
    if (u.hostname === 'duckduckgo.com' && u.pathname === '/l/') {
      const d = u.searchParams.get('uddg')
      if (d) return d
    }
  } catch {
    // not a URL — leave as-is
  }
  return href
}



export interface GateVerdict {
  allowed: boolean
  gated: boolean
  summary: string
  reason: string
  why: string[]
}

export interface SensitiveAction {
  tool: string
  args: Record<string, unknown>
  summary: string
  why: string[]
  domain?: string
}

export interface Policy {
  decide(a: SensitiveAction): boolean | Promise<boolean>
}

export const denyAll: Policy = { decide: () => false }
export const allowAll: Policy = { decide: () => true }
export function promptPolicy(opts: { timeoutMs?: number } = {}): Policy {
  return {
    decide: async (a) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const ans = await Promise.race([
        rl.question(`\n[SAFETY GATE] Approve this action?\n${a.summary}\n\ny/N: `),
        new Promise<string>((r) => setTimeout(() => r(''), opts.timeoutMs ?? 60_000)),
      ]).catch(() => '')
      rl.close()
      return /^y(es)?$/i.test(ans.trim())
    },
  }
}

export const MUTATING = new Set(['navigate', 'click', 'type', 'open_tab', 'switch_tab', 'close_tab', 'select_option', 'upload_file'])
const GATEABLE = new Set(['navigate', 'click', 'type', 'open_tab', 'upload_file', 'select_option'])

async function inspectElement(cdp: CDP, selector: string): Promise<{ summary: string; text: string; href: string; isPassword: boolean } | null> {
  const info = (await cdp.evaluate(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const type = el.getAttribute?.('type') || ''
      const isPassword =
        type === 'password' ||
        (el.getAttribute?.('autocomplete') || '').toLowerCase().includes('password') ||
        /pass|login/.test((el.name || '') + (el.id || ''))
      const text = (el.innerText || el.value || el.placeholder || '').trim().replace(/\\s+/g, ' ').slice(0, 80)
      const href = el.tagName === 'A' ? el.href : ''
      return { tag: el.tagName.toLowerCase(), type, text, href, isPassword }
    })()`
  ).catch(() => null)) as { tag: string; type: string; text: string; href: string; isPassword: boolean } | null
  if (!info) return null
  const kind = info.type ? `${info.tag}[${info.type}]` : info.tag
  const where = info.href ? ` -> ${info.href}` : ''
  const label = info.text ? ` "${info.text}"` : ''
  return { ...info, summary: `<${kind}>${label}${where}` }
}

export async function gate(
  cdp: CDP,
  tool: string,
  args: Record<string, unknown>,
  allowedDomains: string[],
  policy: Policy
): Promise<GateVerdict> {
  if (!GATEABLE.has(tool)) return { allowed: true, gated: false, summary: '', reason: '', why: [] }

  let summary = ''
  let why: string[] = []
  let domain: string | undefined

  if (tool === 'navigate' || tool === 'open_tab') {
    const url = cleanUrl(String(args.url ?? ''))
    domain = urlDomain(url)

    if (!isWebUrl(url)) {
      why = ['non-web scheme']
      summary = `${tool === 'open_tab' ? 'Open tab' : 'Navigate to'} ${url}\nDENIED: only http(s) destinations are allowed`
    } else if (allowedDomains.length > 0 && !inScope(url, allowedDomains)) {
      why = ['outside scoped domains']
      summary = `${tool === 'open_tab' ? 'Open tab' : 'Navigate to'} ${url}\nSCOPING: allowed domains are ${allowedDomains.join(', ')}`
    } else {
      why = matchesBlocklist(url, DESTINATION_RAILS)
      summary = `${tool === 'open_tab' ? 'Open tab' : 'Navigate to'} ${url}`
    }
  } else if (tool === 'upload_file') {
    const sel = `[data-agent-i="${String(args.index)}"]`
    const el = await inspectElement(cdp, sel)
    if (!el) {
      return { allowed: false, gated: true, summary: `upload_file element ${String(args.index)}`, reason: 'element unreadable — denied on uncertainty', why: ['unreadable'] }
    }
    const fileArg = (args.file ?? {}) as { name?: string; path?: string }
    const name = String(fileArg.name ?? String(fileArg.path ?? '').split(/[\\/]/).pop() ?? '?').slice(0, 80)
    summary = `Upload local file "${name}" to ${el.summary}`
    why = ['local file upload']
  } else {
    const sel = `[data-agent-i="${String(args.index)}"]`
    const el = await inspectElement(cdp, sel)
    if (!el) {
      return { allowed: false, gated: true, summary: `${tool} element ${String(args.index)}`, reason: 'element unreadable — denied on uncertainty', why: ['unreadable'] }
    }
    summary = el.summary
    why = matchesBlocklist(`${el.text} ${el.href} ${el.isPassword ? 'password' : ''}`, tool === 'type' ? TYPE_RAILS : BLOCKLIST)
    if (tool === 'type' && el.isPassword) why = why.length ? [...why, 'login'] : ['login']
    if (el.href) {
      const dest = decodeRedirect(el.href)
      if (!isWebUrl(dest)) {
        why = [...why, 'non-web scheme']
      } else if (allowedDomains.length > 0 && !inScope(dest, allowedDomains)) {
        why = [...why, 'outside scoped domains']
      }
    }
  }

  if (why.length === 0) return { allowed: true, gated: false, summary, reason: '', why: [] }

  const action: SensitiveAction = { tool, args, summary, why, domain }
  const allowed = await policy.decide(action)
  return { allowed, gated: true, summary, reason: `matched: ${why.join(', ')}`, why }
}


export interface AuditEntry {
  ts: string
  step?: number
  tool: string
  args: Record<string, unknown>
  url?: string
  verdict: 'executed' | 'denied'
  reason?: string
  summary?: string
}

export function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (k === 'text') out[k] = '[redacted]'
    else if (k === 'file' && typeof v === 'object' && v !== null) {
      const path = String((v as { path?: string }).path ?? '')
      out[k] = { name: path.split(/[\\/]/).pop() || '?' }
    }
    else out[k] = typeof v === 'string' ? scrubPii(v) : v
  }
  return out
}

export class AuditLog {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  append(entry: AuditEntry): void {
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8')
  }

  read(): AuditEntry[] {
    try {
      return readFileSync(this.file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as AuditEntry)
    } catch {
      return []
    }
  }
}
