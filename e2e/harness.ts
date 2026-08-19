import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChrome, waitForPort, CDP, killChrome, CliTabHost } from '../src/browser.ts'
import { runAgent } from '../src/agent.ts'
import { denyAll, AuditLog } from '../src/safety.ts'
import { FactsStore } from '../src/memory.ts'
import { startFixtureServer } from './fixture-server.ts'
import {
  catalogPage, randomCatalog, shopIndexPage, shopCategoryPage, shopProductPage,
  orderFormPage, orderConfirmPage, itemPage, randomShop, randomOrderId,
  hasPrice,
} from './fixtures.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'e2e-'))
const memoryFile = join(tmp, 'facts.json')
const memory = new FactsStore(memoryFile)

interface CaseResult {
  name: string
  steps: number
  tokens: number
  gated: number
  denied: number
  ok: boolean
  detail: string
}

const results: CaseResult[] = []

async function runCase(
  name: string,
  cdp: CDP,
  goal: string,
  verify: (r: { answer: string; steps: number; gated: number; denied: number }) => { ok: boolean; detail: string },
  opts: { tabs?: CliTabHost } = {}
): Promise<void> {
  console.log(`\n=== ${name} ===\nGOAL: ${goal}`)
  const audit = new AuditLog(join(tmp, `audit-${name.replace(/\W+/g, '-').toLowerCase()}.jsonl`))
  const run = await runAgent(cdp, goal, {
    policy: denyAll,
    audit,
    timeBudgetMs: 240_000,
    memory: name.startsWith('memory') ? memory : undefined,
    tabs: opts.tabs,
  })
  const v = verify(run)
  check(name, v.ok, v.detail)
  check(`${name}: ran under deny-all with zero gates`, run.gated === 0 && run.denied === 0, `${run.gated} gated, ${run.denied} denied`)
  results.push({ name, steps: run.steps, tokens: run.totalTokens, gated: run.gated, denied: run.denied, ok: v.ok, detail: v.detail })
}

const { proc, port } = await launchChrome({})
const s1 = await startFixtureServer()
const s2 = await startFixtureServer()
try {
  await waitForPort(port)
  const cdp = await CDP.connect(port)

  // T1: price extraction
  {
    const t = randomCatalog('HoverCam X200')
    s1.set('/catalog', catalogPage(t.products))
    const goal = `Open the catalog at ${s1.url('/catalog?v=1')} and report the exact price of the "HoverCam X200".`
    await runCase('T1 catalog extraction', cdp, goal, (r) => ({
      ok: hasPrice(r.answer, t.target.price),
      detail: `expected $${t.target.price.toFixed(2)} in: ${r.answer.slice(0, 160)}`,
    }))
  }

  // T2: multi-page navigation 
  {
    const t = randomShop('Flux Router 9000')
    s1.set('/shop', shopIndexPage(t.index))
    s1.set(`/shop/${t.category}`, shopCategoryPage(t.category, t.products))
    s1.set(`/shop/${t.category}/flux-9000`, shopProductPage(t.target))
    const goal = `Browse the gadget shop at ${s1.url('/shop')}, open the category that lists the "Flux Router 9000", and report its exact price and stock.`
    await runCase('T2 multi-page navigation', cdp, goal, (r) => ({
      ok: hasPrice(r.answer, t.target.price) && r.answer.includes(String(t.target.stock)),
      detail: `expected $${t.target.price.toFixed(2)}, stock ${t.target.stock} in: ${r.answer.slice(0, 160)}`,
    }))
  }

  // T3: agent-level form wizardry 
  {
    const { createServer } = await import('node:http')
    const live = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      if (path === '/store/entry') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(orderFormPage())
        return
      }
      if (path === '/store/entry/confirm') {
        const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
        const id = randomOrderId()
        const total = Math.round(Math.random() * 10000) / 100
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(orderConfirmPage(q, id, total))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((r) => live.listen(0, '127.0.0.1', r))
    const livePort = (live.address() as { port: number }).port
    const goal = `Fill the order form at http://127.0.0.1:${livePort}/store/entry with name "Grace Hopper", email "grace@hopper.dev", birth date "1906-12-09", country "United Kingdom", then click Continue and report the order ID and total shown on the confirmation page.`
    await runCase('T3 form wizardry (unguessable order ID)', cdp, goal, (r) => ({

      ok: /ORD-[A-Z0-9]{5}/.test(r.answer) && /\$\d+\.\d{2}/.test(r.answer),
      detail: r.answer.slice(0, 160),
    }))
    live.close()
  }

  {
    const mk = () => randomCatalog('HoverCam X200')
    let prev = mk()
    s1.set('/catalog', catalogPage(prev.products))
    const goal = `Open the catalog at ${s1.url('/catalog?v=1')} and report the exact price of the "HoverCam X200".`

    // First memory run: page shows a NEW price — the recalled fact from T1
    // must be re-verified, not trusted.
    const a = mk()
    while (a.target.price === prev.target.price) a.target.price = Math.round((Math.random() + 0.5) * 100) / 10
    s1.set('/catalog', catalogPage(a.products))
    await runCase('memory: same goal, new truth (re-verify recall)', cdp, goal, (r) => ({
      ok: hasPrice(r.answer, a.target.price) && !hasPrice(r.answer, prev.target.price),
      detail: `new truth $${a.target.price.toFixed(2)} (old $${prev.target.price.toFixed(2)}) in: ${r.answer.slice(0, 160)}`,
    }))
    check('memory: facts file persisted the domain', readFileSync(memoryFile, 'utf8').includes('127.0.0.1'))
    prev = a

    // Second memory run: yet another price. Same goal, different answer.
    const b = mk()
    while (b.target.price === prev.target.price) b.target.price = Math.round((Math.random() + 0.5) * 100) / 10
    s1.set('/catalog', catalogPage(b.products))
    await runCase('memory: same goal, new truth again (no echo)', cdp, goal, (r) => ({
      ok: hasPrice(r.answer, b.target.price) && !hasPrice(r.answer, prev.target.price),
      detail: `new truth $${b.target.price.toFixed(2)} (old $${prev.target.price.toFixed(2)}) in: ${r.answer.slice(0, 160)}`,
    }))
  }

  // T4 (last: it re-points the agent's CDP connection across tabs).
  {
    const devA = { name: 'Nebula One', price: Math.round((Math.random() * 300 + 50) * 100) / 100 }
    const devB = { name: 'Pulsar Mini', price: Math.round((Math.random() * 300 + 50) * 100) / 100 }
    const cheaper = devA.price < devB.price ? devA : devB
    s1.set('/item', itemPage(devA.name, devA.price))
    s2.set('/item', itemPage(devB.name, devB.price))
    const goal = `Open the device page ${s1.url('/item?v=1')} in a new tab, then open ${s2.url('/item?v=1')} in another new tab. Compare the two devices' prices and report which one is cheaper and its exact price.`
    await runCase('T4 tab juggling across two sites', cdp, goal, (r) => ({
      ok: r.answer.toLowerCase().includes(cheaper.name.toLowerCase()) && hasPrice(r.answer, cheaper.price),
      detail: `expected ${cheaper.name} $${cheaper.price.toFixed(2)} in: ${r.answer.slice(0, 160)}`,
    }), { tabs: new CliTabHost(port) })
  }
} finally {
  killChrome(proc)
  s1.close()
  s2.close()
}

 // summary
console.log(`\n${'='.repeat(78)}\nSUMMARY — generality battery (${results.length} runs, all under deny-all)\n`)
console.log('case'.padEnd(42) + 'steps'.padStart(6) + 'tokens'.padStart(9) + 'verdict'.padStart(9))
for (const r of results) {
  console.log(r.name.padEnd(42) + String(r.steps).padStart(6) + String(r.tokens).padStart(9) + (r.ok ? 'PASS' : 'FAIL').padStart(9))
}
console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)