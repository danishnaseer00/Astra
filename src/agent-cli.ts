// agent-cli.ts — run a task: npm run agent -- "your goal here"
// Phase 4 safety flags:
//   --ask                 prompt for approval on gated actions (default: deny)
//   --allow               approve every gated action (controlled demos only)
//   --domains a.com,b.com scope navigation to these domains
//   --max-ms N            time budget in milliseconds (default 5 min)
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { launchChrome, waitForPort, CDP, killChrome } from './browser.ts'
import { runAgent } from './agent.ts'
import { denyAll, allowAll, promptPolicy, AuditLog } from './safety.ts'

const { values, positionals } = parseArgs({
  options: {
    ask: { type: 'boolean' },
    allow: { type: 'boolean' },
    domains: { type: 'string' },
    'max-ms': { type: 'string' },
  },
  allowPositionals: true,
})

const goal =
  positionals.join(' ') ||
  'Find the cheapest book in the Travel category on books.toscrape.com and report its title and price.'

const allowedDomains = values.domains ? String(values.domains).split(',').map((s) => s.trim()).filter(Boolean) : []
const policy = values.allow ? allowAll : values.ask ? promptPolicy() : denyAll
const budget = Number(values['max-ms'])
const timeBudgetMs = values['max-ms'] && Number.isFinite(budget) && budget > 0 ? budget : 5 * 60_000
const audit = new AuditLog(join(process.cwd(), 'logs', 'audit.jsonl'))

const { proc, port } = await launchChrome({})
try {
  await waitForPort(port)
  const cdp = await CDP.connect(port)

  console.log(`GOAL: ${goal}`)
  if (allowedDomains.length) console.log(`SCOPE: ${allowedDomains.join(', ')} (navigation outside is denied)`)
  console.log(`POLICY: ${values.allow ? 'allow-all' : values.ask ? 'ask (terminal prompts)' : 'deny-all (safe default)'}\n`)

  const run = await runAgent(cdp, goal, { policy, allowedDomains, audit, timeBudgetMs })

  console.log(`\n=== RESULT (${run.steps} steps, ~${run.totalTokens.toLocaleString()} tokens) ===\n${run.answer}`)
  console.log(`\nSafety: ${run.gated} gated, ${run.denied} denied — full audit in logs/audit.jsonl`)
} finally {
  killChrome(proc)
}
