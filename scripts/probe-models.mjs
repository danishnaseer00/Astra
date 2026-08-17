import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const candidates = ['deepseek-v4-flash:0731', 'deepseek-v3', 'gemini-3.1-flash-lite', 'gpt-5.4-mini', 'gemini-3-flash']
for (const model of candidates) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 10 }),
      signal: AbortSignal.timeout(25_000),
    })
    const el = ((Date.now() - t0) / 1000).toFixed(1)
    if (res.ok) {
      const j = await res.json()
      console.log(`${model}: OK ${el}s -> ${j.choices?.[0]?.message?.content}`)
    } else {
      console.log(`${model}: HTTP ${res.status} ${el}s -> ${(await res.text()).slice(0, 90)}`)
    }
  } catch (e) {
    console.log(`${model}: ERROR ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${e instanceof Error ? e.message : String(e)}`)
  }
}