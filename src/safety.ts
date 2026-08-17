// safety.ts — Phase 4: the rails from lesson 6 §5.
// 1) Action gating: a blocklist (pay/login/send/delete) pauses the loop with a
//    deterministic summary computed by CODE from the live DOM — never by the LLM.
// 3) Domain scoping: each task declares its domains; navigate outside is a gate.
// 4) Time budget is enforced by the loop; this file owns the verdict + policy.
// 5) Audit log: every action, verdict, and reason, as JSONL on disk.

import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { CDP } from './browser.ts'
import { scrubPii } from './perceive.ts'

// --- Rail 1: the blocklist ---------------------------------------------------
// Words that make an action sensitive. A URL, element text, or input type
// matching ANY rule trips the gate. Deny-by-default bias: a false positive
// costs one step; a false negative costs real money or data.
const BLOCKLIST: { label: string; re: RegExp }[] = [
  { label: 'pay', re: /pay|payment|checkout|purchase|buy-?now|\border\b|billing|\bcart\b/ },
  { label: 'login', re: /log-?in|sign-?in|signup|register|auth|password|credential/ },
  { label: 'send', re: /\bsend\b|submit|publish|post(?!ed)|share|comment|message/ },
  { label: 'delete', re: /\bdelete\b|\bremove\b|destroy|deactivate|close\s*account/ },
]

// The send rail is ACTION-only: navigating to a form page (httpbin's demo
// lives at /forms/post) or typing into a comment field transmits nothing —
// only the click that submits is gated. Destinations keep the rest.
const DESTINATION_RAILS = BLOCKLIST.filter(({ label }) => label !== 'send')
const TYPE_RAILS = BLOCKLIST.filter(({ label }) => label !== 'send')

function matchesBlocklist(text: string, rails: typeof BLOCKLIST): string[] {
  const t = text.toLowerCase()
  const hits: string[] = []
  for (const { label, re } of rails) if (re.test(t)) hits.push(label)
  return [...new Set(hits)]
}

// One sanitizer for URL handling: the gate and the executor must judge the
// same URL, or the model could smuggle junk past one of them.
// Only trailing whitespace is always junk; a trailing ")" is stripped ONLY
// when the URL has no matching "(" (models wrap URLs in prose parens, but
// ")" is legal inside real URLs — Wikipedia titles, disambiguation pages).
export const cleanUrl = (u: string): string => {
  const t = u.trim()
  const opens = (t.match(/\(/g) ?? []).length
  const closes = (t.match(/\)/g) ?? []).length
  return closes > opens ? t.replace(/[)\s]+$/, '') : t
}

// --- Rail 3: domain scoping ---------------------------------------------------
export function inScope(url: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false // unparseable URL is out of scope
  }
  return allowed.some((d) => host === d || host.endsWith('.' + d))
}

// Rail 2 (scheme): only http(s) destinations are ever acceptable. The gate
// must refuse file:/data:/javascript: etc. BEFORE the executor sees them —
// the model should never be able to read local files or run script URLs.
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

// Decode a search-engine redirect URL back to the real destination. The gate
// and the executor must judge the SAME target, or the model could smuggle an
// out-of-scope site through a redirect link (clicking a Bing/DDG result goes
// through a /url?u=... or /l/?uddg=... hop that lands anywhere).
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

// --- The gate ----------------------------------------------------------------

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

// Decides ONE gated action. Called only when a rail matched.
export interface Policy {
  decide(a: SensitiveAction): boolean | Promise<boolean>
}

// The CLI's safe default: sensitive actions are refused, period.
export const denyAll: Policy = { decide: () => false }
// For controlled demos and tests — never for real use.
export const allowAll: Policy = { decide: () => true }
// The terminal's approval card (Phase 5 replaces this with an Electron card).
// Bounded: silence = deny, so an unattended run can never approve itself.
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

// The page-changing tools. SINGLE source of truth: the agent loop uses it to
// refuse batched mutating calls, and the gate gates exactly these. Keep the
// tool list in one place so a new tool can't be forgotten in one of the two
// copies (a real past bug: search navigates, but wasn't gated).
export const MUTATING = new Set(['navigate', 'click', 'type'])
const GATEABLE = MUTATING

// Inspect the target element for click/type gates — code reads the DOM, the
// LLM never writes the summary. Deny on uncertainty: if the page won't tell
// us what the element is, we refuse to touch it.
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

// Judge one tool call against every rail. Not gated → { allowed: true, gated: false }.
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

  if (tool === 'navigate') {
    const url = cleanUrl(String(args.url ?? ''))
    domain = urlDomain(url)
    // Rail 2: refuse non-web schemes outright — deny on uncertainty.
    if (!isWebUrl(url)) {
      why = ['non-web scheme']
      summary = `Navigate to ${url}\nDENIED: only http(s) destinations are allowed`
    } else if (allowedDomains.length > 0 && !inScope(url, allowedDomains)) {
      why = ['outside scoped domains']
      summary = `Navigate to ${url}\nSCOPING: allowed domains are ${allowedDomains.join(', ')}`
    } else {
      why = matchesBlocklist(url, DESTINATION_RAILS)
      summary = `Navigate to ${url}`
    }
  } else {
    const sel = `[data-agent-i="${String(args.index)}"]`
    const el = await inspectElement(cdp, sel)
    if (!el) {
      return { allowed: false, gated: true, summary: `${tool} element ${String(args.index)}`, reason: 'element unreadable — denied on uncertainty', why: ['unreadable'] }
    }
    summary = el.summary
    why = matchesBlocklist(`${el.text} ${el.href} ${el.isPassword ? 'password' : ''}`, tool === 'type' ? TYPE_RAILS : BLOCKLIST)
    if (tool === 'type' && el.isPassword) why = why.length ? [...why, 'login'] : ['login']
    // The click target's REAL destination (past any engine redirect) must
    // respect the same rails as navigate — otherwise scope can be bypassed
    // by clicking a search result that hops to an off-scope site. Only real
    // links carry a destination; buttons/inputs have an empty href and are
    // judged by their text/type above.
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

// --- Rail 5: the audit log -----------------------------------------------------
// JSONL on disk: every action, verdict, and reason. Typed text is redacted —
// the audit stores what was touched, never what was typed.

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
