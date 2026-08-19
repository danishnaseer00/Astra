import type { CDP } from './browser.ts'
import { sleep } from './browser.ts'
import { describeImage } from './llm.ts'

const DESCRIBE_PROMPT =
  'Describe this web page screenshot for an AI agent that must act on the page. ' +
  'Report: (1) the overall layout and what is visually prominent, (2) any content that is ' +
  'visible ONLY visually (images, canvas, charts, icons) and not in the DOM text, ' +
  '(3) anything unusual: overlays, dialogs, bot checks, cookie banners, captchas. ' +
  'Be concise — at most 250 words, factual only, no speculation.'

export async function describePage(cdp: CDP, prompt = DESCRIBE_PROMPT): Promise<string> {
  const png = await cdp.screenshotBase64()
  const out = await describeImage(png, prompt)
  return out.trim().slice(0, 1200)
}

async function clickPuzzleRound(cdp: CDP, rect: { x: number; y: number; width: number; height: number }): Promise<boolean> {
  const png = await cdp.screenshotBase64(rect)
  const reply = await describeImage(
    png,
    'You are solving a web "verify you are human" challenge. The image shows the challenge widget. ' +
      'If it shows a PUZZLE (e.g. "select all images with X" grid, or tiled images to click), ' +
      'reply with ONLY JSON: {"clicks":[{"x":X,"y":Y}, ...]} — one entry per target tile/cell, ' +
      'coordinates on a 0-1000 scale relative to the image (0,0 = top-left). ' +
      'If it shows NO puzzle (only a checkbox, a loading spinner, or "challenge passed"), reply {"clicks":[]}. ' +
      'Never reply with prose — JSON only.'
  )
  const m = reply.match(/\{[\s\S]*\}/)
  if (!m) {
    console.log(`  [vision] unparseable solver reply: ${reply.slice(0, 120)}`)
    return false
  }
  let clicks: { x: number; y: number }[] = []
  try {
    clicks = (JSON.parse(m[0]) as { clicks?: { x?: unknown; y?: unknown }[] }).clicks?.filter(
      (c) => typeof c.x === 'number' && typeof c.y === 'number' && Number.isFinite(c.x) && Number.isFinite(c.y)
    ) as { x: number; y: number }[]
  } catch {
    return false
  }
  if (clicks.length === 0) return false
  console.log(`  [vision] puzzle solver clicked ${clicks.length} target(s)`)
  for (const c of clicks) {
    
    const x = Math.round(rect.x + (Math.min(1000, Math.max(0, c.x)) / 1000) * rect.width)
    const y = Math.round(rect.y + (Math.min(1000, Math.max(0, c.y)) / 1000) * rect.height)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }).catch(() => {})
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
    await sleep(400)
  }
  return true
}

export interface ChallengeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ChallengeSolveResult {
  solved: boolean
  rounds: number
}

export async function solveChallenge(cdp: CDP, rect: ChallengeRect, maxRounds = 3): Promise<ChallengeSolveResult> {
  for (let round = 1; round <= maxRounds; round++) {
    console.log(`  [vision] challenge round ${round}/${maxRounds}`)
    const clicked = await clickPuzzleRound(cdp, rect)
    if (!clicked) return { solved: false, rounds: round - 1 } // no puzzle left — the caller decides
    await sleep(2500) // let the widget evaluate the clicks
    const verdict = await describeImage(
      await cdp.screenshotBase64(rect),
      'Is the challenge still asking for clicks (a puzzle with tiles/checkboxes to select), or is it cleared ' +
        '(a checkmark, "verified", "success", or a spinner that resolves)? Reply with ONE word: STILL or CLEARED.'
    )
    console.log(`  [vision] verdict: ${verdict.trim().slice(0, 60)}`)
    if (/clear|pass|success|done|verified|check/i.test(verdict) && !/still|select|click/i.test(verdict)) {
      return { solved: true, rounds: round }
    }
  }
  return { solved: false, rounds: maxRounds }
}