// recall serve — a zero-dependency HTTP server for the "unified briefing" web
// console: one query federated across cortex / agent-hq / scout / lens, plus a
// live view of which stores are available. Read-only; recall core is async, so
// every handler awaits. Node's built-in http only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep } from 'node:path';
import { recall, status, expand } from './core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

const api = {
  '/api/status': async () => status(),
  '/api/stats': async () => {
    const s = await status();
    const avail = s.stores.filter((x) => x.available);
    return { stores: s.stores.length, available: avail.length,
      entries: avail.reduce((a, x) => a + (x.entries || 0), 0) };
  },
  '/api/search': async (q) => recall(q.q || '', {
    k: q.k ? +q.k : 12,
    max_tokens: q.tokens ? +q.tokens : 2400,
    sources: q.only ? q.only.split(',').filter(Boolean) : undefined,
  }),
  '/api/expand': async (q) => {
    if (!q.source || !q.ref) throw new Error('source and ref required');
    return expand(q.source, q.ref);
  },
  '/api/health': async () => ({ ok: true, service: 'recall', ts: new Date().toISOString() }),
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  // startsWith(PUBLIC) alone lets a SIBLING directory through: if PUBLIC is /app/public, then
  // /app/public-secrets/keys.txt also startsWith('/app/public'). A request path of
  // `/../public-secrets/keys.txt` resolves to exactly that and sailed past the guard. Require the
  // path separator, so "inside PUBLIC" means inside it and not merely next to something spelled
  // like it. (iris had the same bug one file over; this is the same fix, kit-wide.)
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + sep)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  }
}

export function createRecallServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' });
      return res.end();
    }
    const handler = api[url.pathname];
    if (handler) {
      const q = Object.fromEntries(url.searchParams.entries());
      try { return json(res, 200, await handler(q)); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
    return serveStatic(res, url.pathname);
  });
}

export function serve({ port = process.env.RECALL_PORT || 7980 } = {}) {
  const server = createRecallServer();
  server.listen(port, async () => {
    console.log(`\n  ◎ recall console → http://localhost:${port}`);
    try {
      const s = await status();
      const on = s.stores.filter((x) => x.available).map((x) => x.tool);
      console.log(`    stores live: ${on.length ? on.join(', ') : 'none yet — set CORTEX_VAULT / SCOUT_DB / LENS_DB / HQ_URL'}\n`);
    } catch { console.log(''); }
  });
  return server;
}
