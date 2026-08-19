import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const URL =
  'https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap'

const css = await (await fetch(URL, { headers: { 'User-Agent': UA } })).text()
const blocks = css.split('@font-face').slice(1)
const out = []
let n = 0
for (const b of blocks) {
  if (!/U\+0000-00FF/.test(b)) continue
  const family = (b.match(/font-family:\s*'([^']+)'/) ?? [])[1]
  const weight = (b.match(/font-weight:\s*(\d+)/) ?? [])[1]
  const style = (b.match(/font-style:\s*(\w+)/) ?? [])[1] ?? 'normal'
  const url = (b.match(/url\(([^)]+\.woff2)\)/) ?? [])[1]
  if (!family || !weight || !url) continue
  const slug = `${family.toLowerCase().replace(/\s+/g, '-')}-${style}-${weight}.woff2`
  const data = await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer()
  writeFileSync(join('src', 'shell', 'fonts', slug), Buffer.from(data))
  out.push(`@font-face { font-family: '${family}'; font-style: ${style}; font-weight: ${weight}; font-display: swap; src: url('fonts/${slug}') format('woff2'); }`)
  n++
  console.log(`saved ${slug}`)
}
writeFileSync(join('src', 'shell', 'fonts', 'fonts.css'), out.join('\n') + '\n')
console.log(`fonts.css written (${n} faces)`)