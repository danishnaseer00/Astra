// llm.ts — the brain link: a minimal OpenAI-compatible client.
// Phase 2: plain chat. Phase 3: tool calling.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: ToolCallWire[]
}

export interface ToolCallWire {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
}

export interface ChatWithToolsResult {
  content: string
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[]
  finishReason: string
}

const BASE = process.env.LLM_BASE_URL ?? 'https://api.llm7.io/v1'
const KEY = process.env.LLM_API_KEY ?? 'unused'
const MODEL = process.env.LLM_MODEL ?? 'DeepSeek-V4-Flash-0731'

console.log(`[llm:boot] base=${BASE} model=${MODEL} key=${KEY.startsWith('sk') || KEY.length > 12 ? 'set' : 'MISSING/INVALID'}`)

// Free-tier gateways rate-limit hard (30 RPM) and stall connections under
// load. Two defenses: (1) a client-side throttle so we never burst past the
// limit — most 429s (and their 10-30s sleeps) never happen; (2) retry with
// backoff when the gateway still pushes back or drops the connection.
let lastCallAt = 0
const MIN_GAP_MS = 2200

async function callOpenAI(body: Record<string, unknown>): Promise<any> {
  const RETRIES = 8
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    // Throttle: space requests out so bursts don't trip the per-minute cap.
    const wait = lastCallAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    console.log(`[llm:call] attempt=${attempt} t=${new Date().toISOString().slice(11, 19)}`)
    const wd = setTimeout(() => console.log(`[llm:watchdog] fetch STILL PENDING at +35s (abort should have fired) attempt=${attempt}`), 35_000)
    let res: Response
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY}`,
          // No keep-alive: undici can deadlock on a stale pooled socket (the
          // gateway's edge silently kills idle connections — headers arrive,
          // then the body stalls forever and even the abort never fires).
          Connection: 'close',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      })
      clearTimeout(wd)
      console.log(`[llm:res] status=${res.status}`)
      lastCallAt = Date.now()
    } catch (err) {
      clearTimeout(wd)
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  (llm stalled — ${msg}; retrying in ${Math.min(20, (1500 * Math.pow(2, attempt)) / 1000)}s)`)
      if (attempt === RETRIES) throw new Error(`LLM request failed: ${msg}`)
      await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)))
      continue
    }
    if (res.ok) {
      const j = await res.json()
      console.log(`[llm:json] parsed ok (choices=${j.choices?.length ?? 0})`)
      return j
    }
    if (res.status === 429 && attempt < RETRIES) {
      // The gateway reports the wait inside error.retry_after — honor it,
      // but never sleep longer than 20s on a single retry.
      const body = (await res.json().catch(() => ({}))) as { error?: { retry_after?: number }; retry_after?: number }
      const retryAfter = Math.min(20, Number(body.error?.retry_after ?? body.retry_after ?? 2))
      console.log(`  (rate limited — retrying in ${retryAfter}s)`)
      await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000))
      continue
    }
    throw new Error(`LLM request failed (${res.status}): ${await res.text()}`)
  }
  throw new Error('LLM request failed: retries exhausted')
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.4,
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens
  const json = await callOpenAI(body)
  return json.choices?.[0]?.message?.content ?? ''
}

// Tool-calling round: the model replies with either text or one+ tool calls.
export async function chatWithTools(
  messages: ChatMessage[],
  tools: ToolSchema[],
  opts: ChatOptions = {}
): Promise<ChatWithToolsResult> {
  const json = await callOpenAI({
    model: MODEL,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: opts.temperature ?? 0.4,
  })
  const msg = json.choices?.[0]?.message
  const toolCalls = (msg?.tool_calls ?? []).map((tc: ToolCallWire) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments)
    } catch {
      // malformed arguments: pass through, the executor will report the failure
    }
    return { id: tc.id, name: tc.function.name, args }
  })
  return { content: msg?.content ?? '', toolCalls, finishReason: json.choices?.[0]?.finish_reason ?? '' }
}