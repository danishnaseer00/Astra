// vision-cli.ts — Phase 7 vision grounding verification (no agent, no LLM
// beyond the vision calls themselves): the solver must read a local
// captcha-like puzzle out of a clipped iframe screenshot and click the
// answers. npm run vision-test
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { launchChrome, waitForPort, CDP, killChrome } from './browser.ts'
import { buildSnapshot } from './perceive.ts'
import { solveChallenge } from './vision.ts'
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

  // 1) The challenge iframe must be detected with a real rect.
  await cdp.navigate(srv.url('challenge.html'))
  const snap = await buildSnapshot(cdp)
  check('challenge iframe detected with rect', !!snap.challengeRect, snap.challengeRect ? `${snap.challengeRect.width}x${snap.challengeRect.height}` : 'none')

  // 2) The solver must read the puzzle and click all red squares.
  if (snap.challengeRect) {
    const result = await solveChallenge(cdp, snap.challengeRect, 3)
    check('vision solver reports success', result.solved, `rounds=${result.rounds}`)
    const status = (await cdp.evaluate(
      `document.querySelector('iframe').contentDocument?.getElementById('status')?.textContent ?? ''`
    )) as string
    check('puzzle frame verified CLEARED', status.includes('Verified'), status)
    const title = (await cdp.evaluate(`document.querySelector('iframe').contentDocument?.title ?? ''`)) as string
    check('puzzle frame title reflects cleared', title.includes('CLEARED'), title)
  }
} finally {
  killChrome(proc)
  srv.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)