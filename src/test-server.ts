// test-server.ts — serve the test/ fixtures over localhost for the Phase 7
// verification CLIs (file:// URLs are awkward for the browser's HTTP APIs).
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

export interface TestServer {
  port: number
  url: (path: string) => string
  close: () => void
}

export async function serveTestDir(dir: string): Promise<TestServer> {
  const root = dir.replace(/[\\/]+$/, '')
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0])
    const file = join(root, path === '/' ? 'index.html' : path)
    // Never serve outside the fixture dir (defense in depth for a dev server).
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { port, url: (p: string) => `http://127.0.0.1:${port}/${p}`, close: () => server.close() }
}