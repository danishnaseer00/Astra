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
  // Form wizardry: the field's name attribute and multi-select flag — a form
  // field is identified by its name/label, not just its position.
  name: string
  multiple: boolean
}

export interface Snapshot {
  url: string
  title: string
  elements: SnapshotElement[]
  render: string
  // Bounding box of the Turnstile/captcha iframe, if one is visible.
  // Cross-origin frames are unreadable from the main frame, but TRUSTED INPUT
  // EVENTS at these coordinates land inside the widget — the checkbox tick
  // clicks the center, and the vision solver clips this rect to read puzzles.
  challengeRect: { x: number; y: number; width: number; height: number } | null
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
  // URL and title can carry PII (emails, tokens, query strings) — scrub them
  // before the render ever reaches the model.
  const url = scrubPii(raw.url)
  const title = scrubPii(raw.title)
  const challenge = detectChallenge(title, scrubPii(raw.bodyText))
  const warning = challenge
    ? '\n⚠ CHALLENGE PAGE (bot check in an iframe — the agent will try to tick the checkbox; if the challenge persists, do NOT waste more steps. Use the search tool or navigate to another source.)\n'
    : ''
  // A page with almost no interactive elements is usually a JS app that never
  // hydrated for us or a bot wall — NOT an empty page to keep retrying.
  // The nav-chrome threshold alone is useless on real sites (a pricing page
  // has dozens of nav links), so also treat a page whose readable text is
  // tiny as blind: real content is at least a paragraph of prose.
  const contentless = raw.bodyText.trim().length < 120
  const blind = (elements.length < 5 || contentless) && !challenge
    ? '\n⚠ This page exposes almost no content (JS-rendered shell or bot protection). Do NOT keep navigating to it. Use the search tool or answer from facts already gathered.\n'
    : ''
  return { ...raw, url, title, elements, render: renderSnapshot(url, title, elements) + warning + blind }
}

// Cloudflare/Turnstile-style "are you a human" challenges run inside a
// cross-origin iframe — the DOM snapshot cannot see into it, but a TRUSTED
// INPUT EVENT at the iframe's coordinates ticks the checkbox regardless of
// origin. The agent auto-clicks it (bounded), then routes around if needed.
const CHALLENGE_RE = /verify you are human|are you a human|turnstile|cf-chl|checking your browser|security check/i

export function detectChallenge(title: string, text: string): boolean {
  return CHALLENGE_RE.test(`${title} ${text}`)
}

// The exact text the LLM reads — indexed so the agent can point at things.
// Lossy by design (lesson 3): the model sees a capped number of elements
// (buildSnapshot already slices to 120, so no second cap is needed here).
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