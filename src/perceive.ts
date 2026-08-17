// perceive.ts — Phase 2: turn the page into what the agent sees.
// Builds an indexed snapshot of interactive elements and scrubs PII
// BEFORE anything leaves the machine toward the LLM (lesson 3).

import type { CDP } from './browser.ts'

export interface SnapshotElement {
  i: number
  tag: string
  type: string
  text: string
  href: string
}

export interface Snapshot {
  url: string
  title: string
  elements: SnapshotElement[]
  render: string
}

// Sensitive data must never reach the model: replace, don't strip.
// Order matters: card numbers are pure digits, so scrub them first.
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g
const PHONE_RE = /\+?\b\d[\d\s().-]{7,}\d\b/g
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g

export function scrubPii(text: string): string {
  return text
    .replace(CARD_RE, '[CARD]')
    .replace(PHONE_RE, '[PHONE]')
    .replace(EMAIL_RE, '[EMAIL]')
}

// Walk the page and index what an agent could interact with.
export async function buildSnapshot(cdp: CDP): Promise<Snapshot> {
  const raw = (await cdp.evaluate(
    `(() => {
      const tags = 'a,button,input,textarea,select,[role="button"],[contenteditable],summary'
      const els = [...document.querySelectorAll(tags)].filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return false
        const st = getComputedStyle(el)
        if (st.visibility === 'hidden' || st.display === 'none') return false
        return true
      }).slice(0, 120)
      return {
        url: location.href,
        title: document.title,
        elements: els.map((el, i) => {
          // The index→selector bridge: the executor looks elements up by this attribute.
          el.setAttribute('data-agent-i', String(i))
          const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '')
            .trim().replace(/\\s+/g, ' ').slice(0, 100)
          const href = el.tagName === 'A' ? el.getAttribute('href') || '' : ''
          return { i, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', text, href: href.slice(0, 200) }
        })
      }
    })()`
  )) as { url: string; title: string; elements: SnapshotElement[] }

  const elements = raw.elements.map((el) => ({ ...el, text: scrubPii(el.text), href: scrubPii(el.href) }))
  return { ...raw, elements, render: renderSnapshot(raw.url, raw.title, elements) }
}

// The exact text the LLM reads — indexed so the agent can point at things.
// Lossy by design (lesson 3): the model sees a capped number of elements.
export function renderSnapshot(url: string, title: string, elements: SnapshotElement[], cap = 100): string {
  const shown = elements.slice(0, cap)
  const lines = shown.map((el) => {
    const kind = el.type ? `${el.tag}[${el.type}]` : el.tag
    const where = el.href ? ` -> ${el.href}` : ''
    const label = el.text ? ` "${el.text}"` : ''
    return `[${el.i}] <${kind}>${label}${where}`
  })
  const more = elements.length > cap ? `... (+${elements.length - cap} more elements not shown)\n` : ''
  return `URL: ${url}\nTITLE: ${title}\n${lines.join('\n')}\n${more}`
}