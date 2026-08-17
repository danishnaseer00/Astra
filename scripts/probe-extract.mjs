import { app, BrowserWindow } from 'electron'

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('https://books.toscrape.com/')
  await new Promise((r) => setTimeout(r, 1500))
  const rows = await win.webContents.executeJavaScript(
    `(() => {
      const els = [...document.querySelectorAll('article, li, .product, [class*="product"], .card, tr')]
      const total = els.length
      const withPrice = els.filter((el) => /[£$€]\\s?\\d/.test(el.innerText || '')).length
      const rows = els.filter((el) => /[£$€]\\s?\\d/.test(el.innerText || ''))
        .map((el) => {
          const price = (el.innerText.match(/[£$€]\\s?\\d+\\.?\\d*/) || [''])[0].trim()
          const title = (el.querySelector('h1, h2, h3, h4, a[title], .title, td')?.innerText || el.innerText.split('\\n').find((l) => l.trim()) || '').trim().slice(0, 80)
          return price && title !== price ? price + ' — ' + title : null
        })
        .filter(Boolean)
      const books = document.querySelectorAll('ol.row li').length
      return { total, withPrice, unique: [...new Set(rows)].length, rows: [...new Set(rows)].slice(0, 40), books }
    })()`
  )
  console.log(JSON.stringify({ url: 'homepage', ...rows }, null, 2))
  app.quit()
}).catch((e) => { console.error(e); app.exit(1) })