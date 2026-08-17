// safety-cli.ts — Phase 4 verification: the rails, tested (no LLM involved).
// npm run safety
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChrome, waitForPort, CDP, killChrome } from './browser.ts'
import { gate, inScope, cleanUrl, decodeRedirect, AuditLog, denyAll, allowAll, sanitizeArgs } from './safety.ts'
import type { GateVerdict } from './safety.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- Rail 1 + 3: pure URL gates (no Chrome needed; navigate never touches the DOM) ---
const fake = {} as CDP
const nav = (url: string, domains: string[] = []): Promise<GateVerdict> => gate(fake, 'navigate', { url }, domains, denyAll)

check('cleanUrl strips whitespace + unbalanced trailing paren', cleanUrl('https://x.com/a) ') === 'https://x.com/a')
  check('cleanUrl keeps balanced parens (Wikipedia URLs)', cleanUrl('https://en.wikipedia.org/wiki/Foo_(bar)') === 'https://en.wikipedia.org/wiki/Foo_(bar)')
check('decodeRedirect resolves DDG redirect', decodeRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FWeb_browser') === 'https://en.wikipedia.org/wiki/Web_browser')
check('decodeRedirect passes through plain URLs', decodeRedirect('https://books.toscrape.com/') === 'https://books.toscrape.com/')
check('inScope exact host', inScope('https://books.toscrape.com/', ['books.toscrape.com']))
check('inScope subdomain', inScope('https://sub.books.toscrape.com/', ['books.toscrape.com']))
check('inScope rejects other hosts', !inScope('https://en.wikipedia.org/', ['books.toscrape.com']))
check('inScope rejects junk URLs', !inScope('not a url', ['books.toscrape.com']))
check('no scope configured = everything in scope', inScope('https://en.wikipedia.org/', []))

let v = await nav('https://books.toscrape.com/')
check('navigate on-domain not gated', !v.gated)
v = await nav('https://en.wikipedia.org/wiki/Web_browser', ['books.toscrape.com'])
check('navigate off-domain gated (scope)', v.gated && v.why.includes('outside scoped domains'), v.reason)
v = await nav('https://shop.example.com/checkout')
check('navigate to checkout gated (pay)', v.gated && v.why.includes('pay'), v.reason)
v = await nav('https://example.com/login')
check('navigate to login gated (login)', v.gated && v.why.includes('login'), v.reason)
v = await nav('https://example.com/delete-account')
check('navigate to delete gated (delete)', v.gated && v.why.includes('delete'), v.reason)
v = await nav('https://example.com/profile')
check('navigate benign not gated', !v.gated)
v = await nav('https://example.com/order-history')
check('navigate order-history gated (pay)', v.gated && v.why.includes('pay'), v.reason)
v = await nav('https://httpbingo.org/forms/post')
check('navigate to form page not gated (send is action-only)', !v.gated)
v = await nav('file:///C:/Users/me/secret.txt')
check('navigate to file:// gated (non-web scheme)', v.gated && v.why.includes('non-web scheme'), v.reason)
v = await nav('javascript:alert(1)')
check('navigate to javascript: gated (non-web scheme)', v.gated && v.why.includes('non-web scheme'), v.reason)

// --- Rail 1: DOM-dependent gates (click/type — real Chrome, offline about:blank) ---
const { proc, port } = await launchChrome({})
try {
  await waitForPort(port)
  const cdp = await CDP.connect(port)
  await cdp.navigate('about:blank')
  await cdp.evaluate(
    `document.body.innerHTML = '<a data-agent-i="0" href="https://shop.example.com/checkout">Buy now</a>' +
      '<input data-agent-i="1" type="password" name="login">' +
      '<button data-agent-i="2">Login</button>' +
      '<a data-agent-i="3" href="https://books.toscrape.com/">Books</a>' +
      '<button data-agent-i="4">Add to cart</button>' +
      '<textarea data-agent-i="5">Comment</textarea>' +
      '<button data-agent-i="6">Post comment</button>'`
  )

  v = await gate(cdp, 'click', { index: 0 }, [], denyAll)
  check('click buy-now gated (pay)', v.gated && v.why.includes('pay'), v.reason)
  check('summary is code-computed element info', v.summary.includes('Buy now') && v.summary.includes('shop.example.com'), v.summary)

  v = await gate(cdp, 'type', { index: 1, text: 'hunter2' }, [], denyAll)
  check('type into password gated (login)', v.gated && v.why.includes('login'), v.reason)
  check('summary never echoes typed text', !v.summary.includes('hunter2'), v.summary)

  v = await gate(cdp, 'click', { index: 2 }, [], denyAll)
  check('click Login button gated (login)', v.gated && v.why.includes('login'), v.reason)

  v = await gate(cdp, 'click', { index: 3 }, [], denyAll)
  check('click benign link not gated', !v.gated)

  v = await gate(cdp, 'click', { index: 3 }, ['wikipedia.org'], denyAll)
  check('click link out of scoped domains gated', v.gated && v.why.includes('outside scoped domains'), v.reason)

  v = await gate(cdp, 'click', { index: 4 }, [], denyAll)
  check('click add-to-cart gated (pay)', v.gated && v.why.includes('pay'), v.reason)

  v = await gate(cdp, 'click', { index: 4 }, [], allowAll)
  check('allowAll policy approves', v.gated && v.allowed)

  v = await gate(cdp, 'type', { index: 5, text: 'hello' }, [], denyAll)
  check('type into comment field not gated (typing is local)', !v.gated, v.reason)

  v = await gate(cdp, 'click', { index: 6 }, [], denyAll)
  check('click Post-comment button gated (send)', v.gated && v.why.includes('send'), v.reason)

  v = await gate(cdp, 'extract', { question: 'x' }, [], denyAll)
  check('read-only tools never gated', !v.gated)

  v = await gate(cdp, 'click', { index: 99 }, [], denyAll)
  check('unreadable element denied on uncertainty', v.gated && !v.allowed, v.reason)
} finally {
  killChrome(proc)
}

// --- Rail 5: audit log round-trip ---
const dir = mkdtempSync(join(tmpdir(), 'safety-audit-'))
const log = new AuditLog(join(dir, 'audit.jsonl'))
log.append({ ts: new Date().toISOString(), step: 1, tool: 'navigate', args: { url: 'https://shop.example.com/checkout' }, url: 'https://books.toscrape.com/', verdict: 'denied', reason: 'matched: pay' })
log.append({ ts: new Date().toISOString(), step: 2, tool: 'type', args: sanitizeArgs({ index: 1, text: 'hunter2' }), url: 'https://example.com/login', verdict: 'executed' })
const entries = log.read()
const typedArgs = JSON.stringify(entries[1].args)
check('audit round-trip count', entries.length === 2)
check('audit redacts typed text', typedArgs.includes('[redacted]') && !typedArgs.includes('hunter2'))
check('audit keeps verdicts', entries[0].verdict === 'denied' && entries[1].verdict === 'executed')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
