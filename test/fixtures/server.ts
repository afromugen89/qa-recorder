import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const appDir = join(dirname(fileURLToPath(import.meta.url)), 'app');

export interface DemoServer {
  url: string;
  close(): Promise<void>;
}

function listen(server: Server, host: string): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve(`http://${host}:${(server.address() as AddressInfo).port}`);
    });
  });
}

function handler(crossOrigin: () => string) {
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const cors = { 'access-control-allow-origin': '*' };
    switch (url.pathname) {
      case '/':
      case '/index.html':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(readFileSync(join(appDir, 'index.html'), 'utf8').replace('__CROSS_ORIGIN__', crossOrigin()));
        return;
      case '/frame.html':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(readFileSync(join(appDir, 'frame.html')));
        return;
      case '/api/ok':
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: true }));
        return;
      case '/api/fail':
        res.writeHead(500, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Database timeout' }));
        return;
      case '/api/slow':
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json', ...cors });
          res.end('{"slow":true}');
        }, 1_200);
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  };
}

/** Starts the demo app plus a second origin for cross-origin iframe tests. */
export async function startDemo(): Promise<DemoServer> {
  let crossUrl = '';
  const cross = createServer(handler(() => crossUrl));
  // A different site (localhost vs 127.0.0.1) so Chromium runs it out of process.
  crossUrl = await listen(cross, 'localhost');
  const main = createServer(handler(() => crossUrl));
  const url = await listen(main, '127.0.0.1');
  return {
    url,
    close: async () => {
      await new Promise((r) => main.close(r));
      await new Promise((r) => cross.close(r));
    },
  };
}
