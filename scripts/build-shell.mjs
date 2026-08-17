// Build the Electron shell: bundle main + preload with esbuild (electron is
// external — it's the runtime), copy the panel UI. No runtime deps in dist.
import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(process.cwd(), 'dist')
mkdirSync(join(dist, 'panel'), { recursive: true })

await build({
  entryPoints: ['src/shell/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outfile: join(dist, 'shell-main.cjs'),
  sourcemap: true,
  logLevel: 'warning',
})

await build({
  entryPoints: ['src/shell/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outfile: join(dist, 'shell-preload.cjs'),
  logLevel: 'warning',
})

for (const f of ['panel.html', 'panel.css', 'panel.js', 'ntp.html']) {
  cpSync(join('src', 'shell', f), join(dist, 'panel', f))
}
cpSync(join('src', 'shell', 'fonts'), join(dist, 'panel', 'fonts'), { recursive: true })

console.log('shell built → dist/')
