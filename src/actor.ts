import { launchChrome, waitForPort, CDP, killChrome, sleep } from './browser.ts'

function must(ok: boolean, what: string): asserts ok {
  if (!ok) throw new Error(`action failed: ${what} (element not found or not visible)`)
}

const { proc, port } = await launchChrome({})
try {
  await waitForPort(port)
  const cdp = await CDP.connect(port)

  await cdp.navigate('https://httpbingo.org/forms/post')
  console.log('Opened the demo form. Filling it with trusted events...')

  must(await cdp.type('input[name="custname"]', 'Alice Johnson'), 'fill name')
  must(await cdp.type('input[name="custtel"]', '555-9876'), 'fill phone')
  must(await cdp.type('input[name="custemail"]', 'alice@demo.com'), 'fill email')
  must(await cdp.type('textarea[name="comments"]', 'Phase 1 complete: the actor works'), 'fill comments')
  await cdp.screenshot('actor-before.png')
  console.log('Form filled, screenshot saved. Submitting...')

  must(await cdp.click('button'), 'submit')
  console.log('Clicked submit.')

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