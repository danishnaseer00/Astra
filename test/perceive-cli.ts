import { launchChrome, waitForPort, CDP, killChrome, sleep } from '../src/browser.ts'
import { buildSnapshot } from '../src/perceive.ts'
import { chat } from '../src/llm.ts'

const { proc, port } = await launchChrome({})
try {
  await waitForPort(port)
  const cdp = await CDP.connect(port)

  console.log('=== Part 1: a busy page, through the agent\'s eyes ===')
  await cdp.navigate('https://books.toscrape.com/')
  const shop = await buildSnapshot(cdp)
  console.log(shop.render.slice(0, 1500))
  console.log(`... (${shop.elements.length} elements total)`)

  const answer = await chat([
    {
      role: 'system',
      content: 'You are reading a live web page snapshot. Indexed elements [n] are clickable/typeable. Answer briefly.',
    },
    { role: 'user', content: `Page snapshot:\n${shop.render}\n\nSummarize this page in one sentence, then list 3 things you could do here by index.` },
  ])
  console.log('\nLLM7 says:\n' + answer)

  console.log('\n=== Part 2: PII never leaves the machine ===')
  await cdp.navigate('https://httpbingo.org/forms/post')
  await cdp.type('input[name="custemail"]', 'alice@example.com')
  await cdp.type('input[name="custtel"]', '+1 555-123-4567')
  await sleep(300)

  const form = await buildSnapshot(cdp)
  const shown = form.elements.filter((e) => e.text.includes('alice') || e.text.includes('555') || e.text.includes('[EMAIL]') || e.text.includes('[PHONE]'))
  for (const el of shown) {
    console.log(`[${el.i}] <${el.tag}${el.type ? '[' + el.type + ']' : ''}> "${el.text}"`)
  }
  console.log('The model only ever receives [EMAIL] / [PHONE] placeholders.')
} finally {
  killChrome(proc)
}