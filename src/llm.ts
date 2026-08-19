
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  tool_call_id?: string
  tool_calls?: ToolCallWire[]
}

export interface ToolCallWire {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
  extra_content?: { google?: { thought_signature?: string } }
}

export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatWithToolsResult {
  content: string
  toolCalls: { id: string; name: string; args: Record<string, unknown>; extra_content?: ToolCallWire['extra_content'] }[]
}

export async function chat(messages: ChatMessage[], temperature = 0.4): Promise<string> {
  const json = await callOpenAI({ model: MODEL, messages, temperature })
  return json.choices?.[0]?.message?.content ?? ''
}

const BASE = process.env.LLM_BASE_URL ?? 'https://api.llm7.io/v1'
const KEY = process.env.LLM_API_KEY ?? 'unused'
const MODEL = process.env.LLM_MODEL ?? 'DeepSeek-V4-Flash-0731'

console.log(`[llm:boot] base=${BASE} model=${MODEL} key=${KEY.startsWith('sk') || KEY.length > 12 ? 'set' : 'MISSING/INVALID'}`)

let lastCallAt = 0
const MIN_GAP_MS = 4000

interface ChatCompletion {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCallWire[] }
    finish_reason?: string
  }[]
}

async function callOpenAI(body: Record<string, unknown>): Promise<ChatCompletion> {
  const RETRIES = 8
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
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

export async function chatWithTools(messages: ChatMessage[], tools: ToolSchema[]): Promise<ChatWithToolsResult> {
  const json = await callOpenAI({
    model: MODEL,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.4,
  })
  const msg = json.choices?.[0]?.message
  const toolCalls = (msg?.tool_calls ?? []).map((tc: ToolCallWire) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments)
    } catch {
    
    }
    return { id: tc.id, name: tc.function.name, args, extra_content: tc.extra_content }
  })
  return { content: msg?.content ?? '', toolCalls }
}


export async function chatVision(messages: { role: 'user' | 'system'; content: ContentPart[] }[]): Promise<string> {
  const json = await callOpenAI({ model: MODEL, messages, temperature: 0.2 })
  return json.choices?.[0]?.message?.content ?? ''
}


export async function describeImage(base64Png: string, prompt: string): Promise<string> {
  return chatVision([
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Png}` } },
      ],
    },
  ])
}