import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const host = '127.0.0.1'
const port = 8080
const root = resolve('game')
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
}

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${host}`).pathname)
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const file = resolve(root, relative)
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    const body = await readFile(file)
    response.writeHead(200, {
      'Cache-Control': relative === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
    })
    response.end(body)
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('BROODLINE asset not found')
  }
}).listen(port, host, () => {
  console.log(`BROODLINE is running at http://${host}:${port}`)
  console.log('Keep this window open while playing. Press Ctrl+C to stop.')
})
