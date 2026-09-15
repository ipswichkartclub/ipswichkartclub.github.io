/**
 * Local dev server - no npm install required.
 *
 *   node dev-server.mjs [--port 8787] [--db path.sqlite] [--seed rows.json]
 *
 * Serves ../docs statically and runs the REAL worker (src/index.js) on /api/*,
 * backed by node:sqlite standing in for D1. Everything stays on your machine.
 *
 * Requires Node 22.5+ (for node:sqlite).
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './src/index.js';

/* ---------------------------------------------------------------- args */

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PORT = Number(arg('port', 8787));
const DB_PATH = arg('db', ':memory:');
const SEED = arg('seed', null);
const ADMIN_KEY = arg('key', 'localdev');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DOCS = normalize(join(HERE, '..', 'docs'));

/* ------------------------------------------------------- D1 shim on sqlite */

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  _p() { return this.db.prepare(this.sql); }
  async first() { const r = this._p().get(...this.args); return r === undefined ? null : r; }
  async all() { return { results: this._p().all(...this.args) }; }
  async run() { const r = this._p().run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const db = new DatabaseSync(DB_PATH);
const fresh = !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
if (fresh) {
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  for (const stmt of schema.split(';')) { const s = stmt.trim(); if (s) db.exec(s); }
}

const env = { DB: new D1(db), ADMIN_KEY, ALLOWED_ORIGINS: '*' };

/* ------------------------------------------------------------------ seed */

let seededUrl = null;
if (SEED && fresh) {
  if (!existsSync(SEED)) {
    console.error('Seed file not found: ' + SEED);
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(SEED, 'utf8'));
  const res = await worker.fetch(new Request('http://local/api/admin/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ADMIN_KEY },
    body: JSON.stringify({
      name: arg('name', 'Local Test Meeting'),
      date: arg('date', new Date().toISOString().slice(0, 10)),
      rows,
    }),
  }), env);
  const body = await res.json();
  if (res.status !== 201) {
    console.error('Seed failed:', body);
    process.exit(1);
  }
  seededUrl = `http://localhost:${PORT}/index.html?e=${body.event.id}`;
  console.log(`Seeded "${body.event.name}": ${body.people} people, ${body.entries} entries.`);
}

/* --------------------------------------------------------- static files */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(DOCS, rel));
  if (!full.startsWith(DOCS)) { res.writeHead(403).end('Forbidden'); return; }
  if (!existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found: ' + rel);
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(full));
}

/* -------------------------------------------------------------- server */

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (!url.pathname.startsWith('/api')) {
    serveStatic(url.pathname, res);
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
    }
    // Stand in for the Cloudflare edge header the worker reads.
    headers.set('CF-Connecting-IP', req.socket.remoteAddress || '127.0.0.1');

    try {
      const request = new Request('http://localhost' + req.url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const out = await worker.fetch(request, env);
      const text = await out.text();
      const outHeaders = {};
      out.headers.forEach((v, k) => { outHeaders[k] = v; });
      res.writeHead(out.status, outHeaders);
      res.end(text);
      if (req.method !== 'GET') console.log(`  ${req.method} ${url.pathname} -> ${out.status}`);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
    }
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Driver briefing check-in - local dev server');
  console.log('  ------------------------------------------');
  console.log(`  Admin      http://localhost:${PORT}/admin.html`);
  console.log(`  Admin key  ${ADMIN_KEY}`);
  if (seededUrl) console.log(`  Check-in   ${seededUrl}`);
  else console.log(`  Check-in   create an event in the admin page first`);
  console.log(`  Database   ${DB_PATH === ':memory:' ? 'in memory (resets on restart)' : DB_PATH}`);
  console.log('');
  console.log('  Ctrl+C to stop.');
  console.log('');
});
