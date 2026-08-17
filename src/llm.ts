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

async function callOpenAI(body: Record<string, unknown>): Promise<any> {
  // Free-tier gateways rate-limit hard (30 RPM): back off and retry instead of
  // crashing the run. A stuck call must not stall the agent forever either.
  const RETRIES = 6
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let res: Response
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      })
    } catch (err) {
      if (attempt === RETRIES) throw new Error(`LLM request failed: ${err instanceof Error ? err.message : String(err)}`)
      await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)))
      continue
    }
    if (res.ok) return res.json()
    if (res.status === 429 && attempt < RETRIES) {
      const retryAfter = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 2)
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