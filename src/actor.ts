// actor.ts — Phase 1 win: drive a real site with trusted input events.
// Fills httpbin.org's classic demo form and submits it.
import { launchChrome, waitForPort, CDP, killChrome, sleep } from './browser.ts'

// The executor must surface failures, never swallow them silently.
function must(ok: boolean, what: string): asserts ok {
  if (!ok) throw new Error(`action failed: ${what} (element not found or not visible)`)
}

const { proc, port } = launchChrome({})
try {
  await waitForPort(port)
  const cdp = await CDP.connect(port)

  // httpbingo.org is the maintained fork of httpbin (which frequently 503s);
  // same form structure: custname/custtel/custemail fields + bare submit button.
  await cdp.navigate('https://httpbingo.org/forms/post')
  console.log('Opened the demo form. Filling it with trusted events...')

  must(await cdp.type('input[name="custname"]', 'Alice Johnson'), 'fill name')
  must(await cdp.type('input[name="custtel"]', '555-9876'), 'fill phone')
  must(await cdp.type('input[name="custemail"]', 'alice@demo.com'), 'fill email')
  must(await cdp.type('textarea[name="comments"]', 'Phase 1 complete: the actor works'), 'fill comments')
  await cdp.screenshot('actor-before.png')
  console.log('Form filled, screenshot saved. Submitting...')

  // httpbin's submit control is a bare <button> — no type attribute.
  must(await cdp.click('button'), 'submit')
  console.log('Clicked submit.')

  // The form POSTs to /post — wait for the navigation to land.
  for (let i = 0; i < 30; i++) {
    const href = (await cdp.evaluate('location.href')) as string
    if (href.includes('/post')) break
    await sleep(500)
  }

  const href = (await cdp.evaluate('location.href')) as string
  console.log('URL now:', href)
  if (!href.includes('/post')) throw new Error('navigation to /post never happened')

  const echo = (await cdp.evaluate('document.body.innerText')) as string
  console.log('Server received:\n' + echo.slice(0, 400))
  await cdp.screenshot('actor-after.png')
  console.log('Saved actor-after.png — open it and compare with actor-before.png')
} finally {
  killChrome(proc)
}