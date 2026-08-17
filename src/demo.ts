// demo.ts — Phase 0 win: launch Chrome, connect over CDP, read + shoot.
import { launchChrome, waitForPort, CDP, killChrome } from './browser.ts'

const { proc, port } = launchChrome({})
try {
  await waitForPort(port)
  const cdp = await CDP.connect(port)

  const title = await cdp.evaluate('document.title')
  console.log('Page title:', JSON.stringify(title))

  await cdp.screenshot('demo.png')
  console.log('Saved demo.png')

  cdp.close()
} finally {
  killChrome(proc)
}