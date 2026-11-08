// Local test harness: runs the REAL worker.js against a D1-compatible shim (node:sqlite) + static assets.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';
import worker from '../worker.js';
const PORT = +process.env.PORT || 8799, DBF = process.env.DBFILE || '/tmp/studio-test.db', PUB = path.resolve('../public');
const db = new DatabaseSync(DBF); db.exec(fs.readFileSync('../schema.sql', 'utf8'));
const cv = (a) => a.map((x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x));
class St { constructor(s) { this.s = db.prepare(s); this.a = []; } bind(...a) { this.a = cv(a); return this; }
  async first() { return this.s.get(...this.a) ?? null; } async all() { return { results: this.s.all(...this.a) }; }
  async run() { const r = this.s.run(...this.a); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
const env = { DB: { prepare: (s) => new St(s) }, ADMIN_PASSWORD: 'Marim*', GROQ_API_KEY: 'k', GROQ_URL: `http://localhost:${PORT}/mock/groq`, POLLINATIONS_URL: `http://localhost:${PORT}/mock/poll`, SESSION_SECRET: 'test-secret', GOOGLE_USERINFO: `http://localhost:${PORT}/mock/google`,
  ASSETS: { async fetch(req) { let p = new URL(req.url).pathname; if (p === '/') p = '/index.html'; const f = path.join(PUB, p);
    if (!f.startsWith(PUB) || !fs.existsSync(f)) return new Response('nf', { status: 404 });
    return new Response(fs.readFileSync(f), { headers: { 'content-type': mime[path.extname(f)] || 'application/octet-stream' } }); } } };
http.createServer(async (rq, rs) => {
  const chunks = []; for await (const c of rq) chunks.push(c); const body = Buffer.concat(chunks);
  const url = `http://localhost:${PORT}${rq.url}`;
  if (rq.url.startsWith('/mock/google')) { const t = (rq.headers.authorization || '').replace('Bearer ', ''); const u = { tokA: { email: 'a@x.com', name: 'عميل A', email_verified: true }, tokB: { email: 'b@x.com', name: 'عميل B', email_verified: true } }[t];
    rs.writeHead(u ? 200 : 401, { 'content-type': 'application/json' }); return rs.end(JSON.stringify(u || { error: 'bad' })); }
  if (rq.url.startsWith('/mock/groq')) { rs.writeHead(500); return rs.end('down'); }
  if (rq.url.startsWith('/mock/poll')) { const b = JSON.parse(body.toString() || '{}'); const sys = (b.messages && b.messages[0] && b.messages[0].content) || '';
    rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ choices: [{ message: { content: 'رد تجريبي | sys:' + (/محمد عبد الحليم ستوديو/.test(sys) ? 'ok' : 'no') + ' | rec:' + (/رسم غرافيتي/.test(sys) ? 'cats' : 'nocats') } }] })); }
  const req = new Request(url, { method: rq.method, headers: rq.headers, body: ['GET', 'HEAD'].includes(rq.method) ? undefined : body });
  Object.defineProperty(req, 'cf', { value: { country: 'EG', region: 'Cairo Governorate', city: 'Cairo' } });
  const res = await worker.fetch(req, env, {}); const buf = Buffer.from(await res.arrayBuffer());
  rs.writeHead(res.status, Object.fromEntries(res.headers)); rs.end(buf);
}).listen(PORT, () => console.log('ready', PORT));
