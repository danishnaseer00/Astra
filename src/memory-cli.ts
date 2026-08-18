// memory-cli.ts — Phase 7 persistent memory verification: store → reload →
// recall round-trip across instances, plus domain extraction. npm run memory-test
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FactsStore, extractDomains } from './memory.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'memory-test-'))
const file = join(dir, 'facts.json')

const store = new FactsStore(file)
store.remember('books.toscrape.com', 'Find the cheapest Travel book', ['Travel: 12 books', 'prices listed on page'], 'The Road to Little Dribbling — £23.21')
store.remember('books.toscrape.com', 'Find the best-rated SciFi book', [], 'Dune — rating Five')
store.remember('example.com', 'x', [], 'y')

const rec = store.recallForDomains(['books.toscrape.com'])
check('recall returns the newest answer', rec.includes('Dune — rating Five'), rec.slice(0, 120))
check('recall caps entries per domain', (rec.match(/goal:/g) ?? []).length <= 3)
const rec2 = store.recallForDomains(['example.com'])
check('recall scopes by domain', rec2.includes('y') && !rec2.includes('Little Dribbling'))

// A fresh store reading the same file — this is what "survives a restart" means.
const store2 = new FactsStore(file)
const rec3 = store2.recallForDomains(['books.toscrape.com'])
check('facts persist across instances', rec3.includes('£23.21') && rec3.includes('Dune'))
check('recall of unknown domain is empty', store2.recallForDomains(['nowhere.net']) === '')

// Domain extraction from goals.
check('extracts URLs from goal', extractDomains('compare https://example.com/pricing vs https://other.io/').includes('example.com'))
check('extracts bare domains ("on X.com")', extractDomains('find the price of X on amazon.com').includes('amazon.com'))
check('extracts books.toscrape.com goal', extractDomains('cheapest book on books.toscrape.com').includes('books.toscrape.com'))
check('ignores bare words', extractDomains('find the cheapest book on the store page').length === 0)

// Hostile input must not corrupt the file or leak into recall.
store.remember('../etc/passwd', 'hack', [], 'evil')
store.remember('javascript:alert(1)', 'hack', [], 'evil')
const rec4 = store2.recallForDomains(['../etc/passwd', 'javascript:alert(1)'])
check('malicious domains rejected from store', rec4 === '')
const raw = readFileSync(file, 'utf8')
check('file holds no hostile keys', !raw.includes('etc/passwd') && !raw.includes('javascript'))

// Caps: 6 stores on one domain keep only the newest 5 (recall shows tail 3).
for (let i = 0; i < 6; i++) store.remember('cap.test', `g${i}`, [], `a${i}`)
const rec5 = store.recallForDomains(['cap.test'])
check('recall surfaces newest entries', (rec5.match(/goal:/g) ?? []).length === 3 && rec5.includes('a5'))
const fileData = JSON.parse(readFileSync(file, 'utf8'))
check('store capped at 5 entries per domain', fileData.domains['cap.test'].length === 5, String(fileData.domains['cap.test'].length))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)