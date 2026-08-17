import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const tools = [
  { type: 'function', function: { name: 'search', description: 'Search the web for a query.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'navigate', description: 'Navigate to a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'click', description: 'Click the element with this snapshot index.', parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] } } },
  { type: 'function', function: { name: 'type', description: 'Type text into the input with this snapshot index.', parameters: { type: 'object', properties: { index: { type: 'integer' }, text: { type: 'string' } }, required: ['index', 'text'] } } },
  { type: 'function', function: { name: 'extract', description: 'Extract text from elements matching a CSS selector.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } } },
  { type: 'function', function: { name: 'scroll', description: 'Scroll the page.', parameters: { type: 'object', properties: { dir: { type: 'string', enum: ['up', 'down'] } }, required: ['dir'] } } },
  { type: 'function', function: { name: 'done', description: 'Finish and answer.', parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } } },
]
const messages = [
  { role: 'system', content: 'You are an agent. CURRENT SNAPSHOT (fresh):\nURL: about:blank\nTITLE: agentic-browser-comet\n' },
  { role: 'user', content: 'GOAL: Find the cheapest book in the Travel category on books.toscrape.com and report its title and price.' },
]
console.log('sending decide-shaped request at', new Date().toISOString())
const t0 = Date.now()
try {
  const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({ model: env.LLM_MODEL, messages, tools, tool_choice: 'auto', temperature: 0.4 }),
    signal: AbortSignal.timeout(30_000),
  })
  console.log('status', res.status, 'after', ((Date.now() - t0) / 1000).toFixed(1) + 's')
  if (res.ok) {
    const j = await res.json()
    console.log('finish:', j.choices?.[0]?.finish_reason, 'tool_calls:', JSON.stringify(j.choices?.[0]?.message?.tool_calls ?? []).slice(0, 120))
  } else {
    console.log('body:', (await res.text()).slice(0, 200))
  }
} catch (e) {
  console.log('ERROR after', ((Date.now() - t0) / 1000).toFixed(1) + 's:', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
}