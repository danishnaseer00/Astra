import { createServer, type Server } from 'node:http'

export interface FixtureServer {
  port: number
  url: (path: string) => string
  set: (path: string, html: string) => void
  close: () => void
}

export function startFixtureServer(): Promise<FixtureServer> {
  const routes = new Map<string, string>()
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0])
    const html = routes.get(path)
    if (!html) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        url: (p: string) => `http://127.0.0.1:${port}${p}`,
        set: (path, html) => routes.set(path, html),
        close: () => server.close(),
      })
    })
  })
}