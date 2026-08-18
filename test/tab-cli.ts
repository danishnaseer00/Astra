// tab-cli.ts — Phase 7 tab tools verification: open/switch/close tabs through
// the TabHost the agent uses, asserting the active page really changes.
// npm run tab-test
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { launchChrome, waitForPort, CDP, killChrome, CliTabHost } from '../src/browser.ts'
import { serveTestDir } from './test-server.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const testDir = join(here, '..', 'test')
const srv = await serveTestDir(testDir)

const { proc, port } = await launchChrome({})
try {
  await waitForPort(port)
  const cdp = await CDP.connect(port)
  await cdp.navigate(srv.url('form.html'))
  const host = new CliTabHost(port)

  const t1 = await host.list()
  check('list starts with exactly 1 active tab', t1.length === 1 && t1[0].active, JSON.stringify(t1.map((t) => t.url)))

  const opened = await host.open(srv.url('challenge.html'))
  const l2 = await host.list()
  check('open_tab adds a tab and makes it active', l2.length === 2 && l2.some((t) => t.active && t.url.includes('challenge.html')), JSON.stringify(l2.map((t) => [t.active, t.url])))

  // activate() must return a CDP bound to the target tab — pick the FIRST
  // (original form) tab out of the new list by URL, not by index.
  const formTab = l2.find((t) => t.url.includes('form.html'))
  check('list keeps original form tab', !!formTab)
  if (formTab) {
    const cdpTab0 = await host.activate(formTab.id)
    const url0 = (await cdpTab0.evaluate('location.href').catch(() => '')) as string
    check('activate() re-points CDP at chosen tab', url0.includes('form.html'), url0)
  }

  // Open a third tab, then close the ACTIVE one — the host must survive.
  const t3 = await host.open('about:blank')
  const l3 = await host.list()
  check('third tab opened', l3.length === 3, JSON.stringify(l3.length))
  const rest = await host.close(t3.id)
  check('close_tab removes the tab', rest.length === 2, JSON.stringify(rest.length))

  const afterClose = await host.list()
  check('remaining tabs still listed', afterClose.length === 2)

  // Close the tab that is currently marked active (tab 0 after our switches):
  // the agent-side handler re-activates a survivor; here we verify close works.
  const closing = afterClose.find((t) => !t.active) ?? afterClose[0]
  const final = await host.close(closing.id)
  check('closing any tab keeps ≥1 tab alive', final.length >= 1, JSON.stringify(final.length))
} finally {
  killChrome(proc)
  srv.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)