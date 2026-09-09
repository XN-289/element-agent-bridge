import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixture');
const port = Number(process.env.PORT || 4176);

const server = createServer(async (request, response) => {
  const pathname = request.url === '/' ? '/index.html' : request.url;
  const target = path.join(root, pathname);

  try {
    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': target.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain'
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Element Agent Bridge fixture: http://127.0.0.1:${port}`);
});
