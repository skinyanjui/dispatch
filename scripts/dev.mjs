import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 4173);
const allowed = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/assets/desktop-preview.png', ['assets/desktop-preview.png','image/png']],
  ['/assets/mobile-preview.png', ['assets/mobile-preview.png','image/png']]
]);

createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('ok');
  }
  const asset = allowed.get(path);
  if (!asset || request.method !== 'GET') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('Not found');
  }
  try {
    const body = await readFile(join(directory, asset[0]));
    response.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store', 'x-content-type-options':'nosniff' });
    response.end(body);
  } catch {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('Could not read local demo file');
  }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Relay demo running at http://localhost:${port}\n`);
});
