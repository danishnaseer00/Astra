import type { CDP } from './browser.ts'

export interface SnapshotElement {
  i: number
  tag: string
  type: string
  text: string
  href: string
  name: string
  multiple: boolean
}

export interface Snapshot {
  url: string
  title: string
  elements: SnapshotElement[]
  render: string
  challengeRect: { x: number; y: number; width: number; height: number } | null
}

const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g
const PHONE_RE = /\+?\b\d[\d\s().-]{7,}\d\b/g
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g

export function scrubPii(text: string): string {
  return text
    .replace(CARD_RE, '[CARD]')
    .replace(PHONE_RE, '[PHONE]')
    .replace(EMAIL_RE, '[EMAIL]')
}

export async function buildSnapshot(cdp: CDP): Promise<Snapshot> {
  const raw = (await cdp.evaluate(
    `(() => {
      // Stale index attributes from a previous snapshot must not survive:
      // querySelector finds the FIRST match in document order, so an old
      // attribute on a now-hidden element could hijack a click/gate lookup.
      document.querySelectorAll('[data-agent-i]').forEach((el) => el.removeAttribute('data-agent-i'))
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
        // Head+tail splice: pages lead with nav/boilerplate, so a head-only
        // slice hides the actual content from the snapshot (see extract).
        bodyText: document.body ? (() => {
          const t = document.body.innerText
          if (t.length <= 2000) return t
          return t.slice(0, 1400) + '\\n...[middle ' + (t.length - 2000) + ' chars omitted]...\\n' + t.slice(-600)
        })() : '',
        challengeRect: (() => {
          const f = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[src*="cf-chl"], iframe[title*="challenge" i]')
          if (!f) return null
          const r = f.getBoundingClientRect()
          if (r.width < 20 || r.height < 20) return null
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
        })(),
        elements: els.map((el, i) => {
          // The index→selector bridge: the executor looks elements up by this attribute.
          el.setAttribute('data-agent-i', String(i))
          const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '')
            .trim().replace(/\\s+/g, ' ').slice(0, 100)
          const href = el.tagName === 'A' ? el.getAttribute('href') || '' : ''
          return {
            i,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            text,
            href: href.slice(0, 200),
            name: el.getAttribute('name') || '',
            multiple: el instanceof HTMLSelectElement ? el.multiple : false,
          }
        })
      }
    })()`
  )) as { url: string; title: string; bodyText: string; challengeRect: { x: number; y: number; width: number; height: number } | null; elements: SnapshotElement[] }

  const elements = raw.elements.map((el) => ({ ...el, text: scrubPii(el.text), href: scrubPii(el.href) }))
  const url = scrubPii(raw.url)
  const title = scrubPii(raw.title)
  const challenge = detectChallenge(title, scrubPii(raw.bodyText))
  const warning = challenge
    ? '\n⚠ CHALLENGE PAGE (bot check in an iframe — the agent will try to tick the checkbox; if the challenge persists, do NOT waste more steps. Use the search tool or navigate to another source.)\n'
    : ''
  const contentless = raw.bodyText.trim().length < 120
  const blind = (elements.length < 5 || contentless) && !challenge
    ? '\n⚠ This page exposes almost no content (JS-rendered shell or bot protection). Do NOT keep navigating to it. Use the search tool or answer from facts already gathered.\n'
    : ''
  return { ...raw, url, title, elements, render: renderSnapshot(url, title, elements) + warning + blind }
}


const CHALLENGE_RE = /verify you are human|are you a human|turnstile|cf-chl|checking your browser|security check/i

export function detectChallenge(title: string, text: string): boolean {
  return CHALLENGE_RE.test(`${title} ${text}`)
}

export function renderSnapshot(url: string, title: string, elements: SnapshotElement[]): string {
  const lines = elements.map((el) => {
    const kind = el.type ? `${el.tag}[${el.type}]` : el.tag
    const multi = el.multiple ? '[multiple]' : ''
    const named = el.name ? ` name=${el.name}` : ''
    const where = el.href ? ` -> ${el.href}` : ''
    const label = el.text ? ` "${el.text}"` : ''
    return `[${el.i}] <${kind}${multi}${named}>${label}${where}`
  })
  return `URL: ${url}\nTITLE: ${title}\n${lines.join('\n')}\n`
}