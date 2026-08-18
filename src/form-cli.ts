// form-cli.ts — Phase 7 form wizardry verification: text, email, date, color,
// single + multi select, file upload, checkbox, radio — driven through the
// same CDP methods the agent's tools call. npm run form-test
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { launchChrome, waitForPort, CDP, killChrome } from './browser.ts'
import { buildSnapshot } from './perceive.ts'
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

  const snap = await buildSnapshot(cdp)
  const sel = (i: number) => `[data-agent-i="${i}"]`
  const idx = (name: string) => snap.elements.findIndex((e) => e.name === name)
  const expect = (name: string, i: number) => {
    check(`snapshot indexes field "${name}"`, i >= 0, i >= 0 ? `i=${i}` : 'missing')
    return i
  }

  const nameI = expect('name', idx('name'))
  const emailI = expect('email', idx('email'))
  const birthI = expect('birth', idx('birth'))
  const colorI = expect('color', idx('color'))
  const countryI = expect('country', idx('country'))
  const hobbiesI = expect('hobbies', idx('hobbies'))
  const newsI = expect('news', idx('news'))
  const tierI = expect('tier', idx('tier'))
  const resumeI = expect('resume', idx('resume'))

  check('snapshot marks multi-select', snap.elements[hobbiesI]?.multiple === true)
  check('snapshot carries select name', snap.elements[countryI]?.name === 'country')

  check('type text', (await cdp.type(sel(nameI), 'Ada Lovelace')) === true)
  check('type email', (await cdp.type(sel(emailI), 'ada@example.com')) === true)
  check('type date (script fallback)', (await cdp.type(sel(birthI), '1815-12-10')) === true)
  check('type color (script fallback)', (await cdp.type(sel(colorI), '#ff00ff')) === true)
  check('select single by visible text', (await cdp.selectOption(sel(countryI), ['Germany'])) === true)
  check('select multi by values', (await cdp.selectOption(sel(hobbiesI), ['code', 'hike'])) === true)

  const uploadOk = await cdp.uploadFile(sel(resumeI), {
    name: 'resume.txt',
    type: 'text/plain',
    base64: Buffer.from('hello world').toString('base64'),
  })
  check('upload file', uploadOk === true)

  // Checkbox + radio via the trusted click pipeline (already proven in Phase 1).
  check('click checkbox', (await cdp.click(sel(newsI))) === true)
  check('click radio (pro)', (await cdp.click(sel(tierI + 1))) === true)

  // Submit and read back what the page collected.
  const submitI = snap.elements.findIndex((e) => e.tag === 'button' && e.text === 'Submit form')
  check('snapshot indexes submit button', submitI >= 0)
  if (submitI >= 0) await cdp.click(sel(submitI))

  const out = (await cdp.evaluate(`document.getElementById('out')?.textContent ?? ''`)) as string
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(out) as Record<string, unknown>
  } catch {
    check('form echoed collected values', false, `unparseable: ${out.slice(0, 120)}`)
  }
  if (parsed) {
    check('text field', parsed.name === 'Ada Lovelace', String(parsed.name))
    check('email field', parsed.email === 'ada@example.com', String(parsed.email))
    check('date field', parsed.birth === '1815-12-10', String(parsed.birth))
    check('color field', parsed.color === '#ff00ff', String(parsed.color))
    check('single select', parsed.country === 'de', String(parsed.country))
    check('multi select', JSON.stringify(parsed.hobbies) === JSON.stringify(['code', 'hike']), JSON.stringify(parsed.hobbies))
    check('checkbox', parsed.news === true, String(parsed.news))
    check('radio', parsed.tier === 'pro', String(parsed.tier))
    check('file attached', String(parsed.file).startsWith('resume.txt'), String(parsed.file))
  }
} finally {
  killChrome(proc)
  srv.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)