// Cloudflare Worker: static site + API (D1). Bindings: DB (D1), ASSETS. Secrets: ADMIN_PASSWORD, SESSION_SECRET
const te = new TextEncoder();
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...h } });
const b64u = (buf) => { let s = ''; const u = new Uint8Array(buf); for (const c of u) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
let SECRET = null;
async function secretOf(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (SECRET) return SECRET;
  let r = await env.DB.prepare("SELECT v FROM kv WHERE k='secret'").first();
  if (!r) { await env.DB.prepare("INSERT OR IGNORE INTO kv(k,v) VALUES('secret',?)").bind(b64u(crypto.getRandomValues(new Uint8Array(32)))).run(); r = await env.DB.prepare("SELECT v FROM kv WHERE k='secret'").first(); }
  return (SECRET = r.v);
}
const hmacKey = async (env) => crypto.subtle.importKey('raw', te.encode(await secretOf(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const DEFAULT_ADMIN = 'Marim*'; // used when ADMIN_PASSWORD is not configured; change it from the admin panel
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, dev TEXT NOT NULL, day TEXT NOT NULL, country TEXT, region TEXT, city TEXT, lat REAL, lng REAL, created INTEGER NOT NULL, UNIQUE(dev, day))',
  "CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, no TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, name TEXT, phone TEXT, city TEXT, addr TEXT, design TEXT, size TEXT, slot TEXT, total REAL DEFAULT 0, dep REAL DEFAULT 0, method TEXT, kind TEXT DEFAULT 'inquiry', status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, confirmed_at INTEGER, confirmed_by TEXT)",
  'CREATE INDEX IF NOT EXISTS inv_owner ON invoices(owner, id)',
  'CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, t INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS invoice_files (id TEXT PRIMARY KEY, no TEXT NOT NULL, kind TEXT, mime TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS inv_files_no ON invoice_files(no)',
];
let READY = null;
const init = (env) => READY || (READY = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { READY = null; throw e; })); // tables are created automatically on first request
async function sign(env, payload) { const p = b64u(te.encode(JSON.stringify(payload))); const s = await crypto.subtle.sign('HMAC', await hmacKey(env), te.encode(p)); return p + '.' + b64u(s); }
async function verify(env, tok) {
  try { const [p, s] = String(tok || '').split('.'); if (!p || !s) return null;
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(s), te.encode(p)))) return null;
    const o = JSON.parse(new TextDecoder().decode(unb64u(p))); return o.exp > Date.now() ? o : null; } catch (_) { return null; }
}
const bearer = (req) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
const digits = (v) => String(v == null ? '' : v).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '').slice(0, 20);
const last10 = (v) => digits(v).slice(-10);
const maskPh = (v) => { const d = digits(v); return d.length >= 7 ? d.slice(0, 3) + '****' + d.slice(-3) : '***'; };
const maskName = (v) => String(v || '').trim().split(/\s+/).filter(Boolean).map((x, i) => (i === 0 ? x : x[0] + '••')).join(' ');
async function limited(env, ip, key, max) { const k = key + ':' + ip, now = Date.now(); await env.DB.prepare('DELETE FROM attempts WHERE t<?').bind(now - 600000).run(); const c = await env.DB.prepare('SELECT COUNT(*) n FROM attempts WHERE ip=?').bind(k).first(); if (c.n >= max) return true; await env.DB.prepare('INSERT INTO attempts(ip,t) VALUES(?,?)').bind(k, now).run(); return false; }
const clean = (v, n = 80) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n);
const num = (v) => { const n = +String(v == null ? 0 : v).replace(/[^\d.]/g, ''); return isFinite(n) ? n : 0; };
const eqs = (a, b) => { a = te.encode(String(a)); b = te.encode(String(b)); let r = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a[i] || 0) ^ (b[i] || 0); return r === 0; };
async function pbkdf2(pw, salt) { const k = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']); return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256)); }
async function body(req) { try { return await req.json(); } catch (_) { return {}; } }

async function adminOf(env, req) { const t = await verify(env, bearer(req)); return t && t.r === 'admin' ? t : null; }
async function userOf(env, req) { const t = await verify(env, req.headers.get('x-session')); return t && t.r === 'user' ? t : null; }

async function checkPassword(env, pw) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k='admin_pw'").first();
  if (row) { const [s, h] = row.v.split(':'); return eqs(await pbkdf2(pw, unb64u(s)), h); }
  return eqs(pw, env.ADMIN_PASSWORD || DEFAULT_ADMIN);
}
const stripPublic = (st) => { const o = JSON.parse(JSON.stringify(st || {})); if (o.cfg) { delete o.cfg.ph; delete o.cfg.n8nk; } return o; };


// ---------- AI chat: free providers with automatic fail-over ----------
function describeState(st) {
  const c = st.cfg || [], L = [];
  (st.cats || []).forEach((k) => L.push(`- ${k.n}: ${String(k.info || '').replace(/\s+/g, ' ').slice(0, 220)}` + (k.min ? ` | سعر المتر من ${k.min} إلى ${k.max} ج` : '') + ((k.tiers || []).length ? ' | الأقسام: ' + k.tiers.map((t) => t.n + (t.p ? ` (${t.p} ج/م²)` : '')).join('، ') : '')));
  (st.gal || []).slice(0, 40).forEach((x) => { const k = (st.cats || []).find((q) => q.id === x.cat); L.push(`تصميم: ${x.t || ''} [${k ? k.n : ''}] السعر: ${x.p || 'حسب القسم'} | المقاس: ${x.sz || '-'} | الخامات: ${x.m || '-'} | ${String(x.ds || '').slice(0, 100)}`); });
  if (c.dep) L.push(`العربون للطلبات العادية: ${c.dep}%`);
  if (c.lead) L.push(`أقرب موعد تنفيذ بعد ${c.lead} يوم`);
  return L.join('\n');
}
const APP_GUIDE = 'طريقة العمل داخل التطبيق: اختار التخصص (رسم غرافيتي، نحت Relief، Effect، Tableau) ثم التصميم أو احسب التكلفة وابعت الطلب على واتساب. بعد الإرسال بتتسجل فاتورة برقم INV-xxxx. لمتابعة الفاتورة افتح كارت «فواتيري» وابحث برقم الفاتورة أو برقم الواتساب المكتوب فيها (ولعرض الفاتورة كاملة اكتب الاتنين). لإرسال صورة التحويل افتح الفاتورة واضغط «إرسال صورة التحويل» وبتتبعت للاستوديو مباشرة. الاستوديو بيأكد الدفع وبعدها تظهر الفاتورة «تم الدفع» وتقدر تنزّلها وتشاركها. الـTableau: اختيار من أعمال الاستوديو فقط مع كتابة المقاس المطلوب بالسم، وعربون 50% والخامات شاملة بدون شحن. للتواصل المباشر في كارت «للتواصل المباشر» أعلى الصفحة يفتح واتساب الاستوديو.';
async function sysPrompt(env, ctx) {
  let info = '';
  try { const r = await env.DB.prepare("SELECT v FROM kv WHERE k='studio'").first(); if (r) info = describeState(JSON.parse(r.v).state); } catch (_) {}
  if (!info) info = ctx || '';
  return 'أنت مساعد استوديو "محمد عبد الحليم ستوديو" للفنون. رد بالعامية المصرية بأدب وباختصار (٣ إلى ٥ جمل). '
    + 'اعتمد فقط على معلومات التطبيق التالية للأسعار والتصميمات والمقاسات والخامات وخطوات الطلب، ولا تخترع أرقامًا أو تصميمات؛ لو المعلومة مش موجودة قل إن الاستوديو هيحددها بعد مراجعة التصميم والمقاس. '
    + 'لا تجب عن مواضيع خارج الاستوديو والفن والديكور، ولا تطلب بيانات شخصية حساسة.\n' + APP_GUIDE + (info ? '\nمعلومات التطبيق:\n' + info : '');
}
const sig = () => AbortSignal.timeout(15000);
async function oai(url, key, model, msgs, extraHdr) {
  const r = await fetch(url, { method: 'POST', signal: sig(), headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}), ...(extraHdr || {}) }, body: JSON.stringify({ model, messages: msgs, max_tokens: 500, temperature: 0.6 }) });
  if (!r.ok) throw new Error('http' + r.status);
  const j = await r.json(); return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
}
function providers(env, sys, hist) {
  const msgs = [{ role: 'system', content: sys }, ...hist], L = [];
  if (env.AI) L.push(['cloudflare', async () => { const r = await env.AI.run(env.CF_MODEL || '@cf/meta/llama-3.1-8b-instruct', { messages: msgs, max_tokens: 500 }); return String(r && (r.response || r.result && r.result.response) || '').trim(); }]);
  if (env.GROQ_API_KEY) L.push(['groq', () => oai(env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions', env.GROQ_API_KEY, env.GROQ_MODEL || 'llama-3.3-70b-versatile', msgs)]);
  if (env.GEMINI_API_KEY) L.push(['gemini', async () => {
    const m = env.GEMINI_MODEL || 'gemini-2.0-flash';
    const r = await fetch(env.GEMINI_URL || `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', signal: sig(), headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: hist.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })), generationConfig: { maxOutputTokens: 500, temperature: 0.6 } }) });
    if (!r.ok) throw new Error('http' + r.status); const j = await r.json();
    return String(j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text || '').trim(); }]);
  if (env.OPENROUTER_API_KEY) L.push(['openrouter', () => oai(env.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions', env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', msgs)]);
  L.push(['pollinations', () => oai(env.POLLINATIONS_URL || 'https://text.pollinations.ai/openai', '', 'openai', msgs)]); // no key needed: last fallback
  return L;
}
async function chat(env, req) {
  const ip = req.headers.get('cf-connecting-ip') || 'local', k = 'chat:' + ip, now = Date.now();
  await env.DB.prepare('DELETE FROM attempts WHERE t<?').bind(now - 600000).run();
  const c = await env.DB.prepare('SELECT COUNT(*) n FROM attempts WHERE ip=?').bind(k).first();
  if (c.n >= 20) return J({ error: 'rate' }, 429);
  const b = await body(req);
  const hist = (Array.isArray(b.messages) ? b.messages : []).slice(-8).map((m) => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: clean(m && m.content, 600) })).filter((m) => m.content);
  if (!hist.length || hist[hist.length - 1].role !== 'user') return J({ error: 'bad_request' }, 400);
  await env.DB.prepare('INSERT INTO attempts(ip,t) VALUES(?,?)').bind(k, now).run();
  const sys = await sysPrompt(env, String(b.ctx || '').replace(/[<>\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 3800));
  for (const [name, run] of providers(env, sys, hist)) {
    try { const reply = await run(); if (reply) return J({ reply: reply.slice(0, 1500), provider: name }); } catch (_) {}
  }
  return J({ error: 'busy' }, 503);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    try {
      if (p.startsWith('/api/') || p.startsWith('/img/')) {
        if (!env.DB) return J({ error: 'no_db', msg: 'D1 binding DB is missing' }, 500);
        await init(env);
      }
      if (p.startsWith('/img/') && m === 'GET') {
        const r = await env.DB.prepare('SELECT mime,data FROM images WHERE id=?').bind(p.slice(5)).first();
        if (!r) return new Response('not found', { status: 404 });
        const d = r.data, bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : Array.isArray(d) ? Uint8Array.from(d) : new Uint8Array(d);
        return new Response(bytes, { headers: { 'content-type': r.mime, 'cache-control': 'public, max-age=31536000, immutable' } });
      }
      if (!p.startsWith('/api/')) {
        const res = await env.ASSETS.fetch(req); const h = new Headers(res.headers);
        if (p === '/' || p.endsWith('.html') || p === '/sw.js' || p === '/manifest.json') h.set('cache-control', 'no-cache');
        return new Response(res.body, { status: res.status, headers: h });
      }
      // ---------- public ----------
      if (p === '/api/studio' && m === 'GET') {
        const r = await env.DB.prepare("SELECT v FROM kv WHERE k='studio'").first();
        if (!r) return J({ empty: true });
        const o = JSON.parse(r.v); return J({ rev: o.rev, state: stripPublic(o.state) });
      }
      if (p === '/api/visit' && m === 'POST') {
        const b = await body(req), cf = req.cf || {}, dev = clean(b.dev, 64);
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(dev)) return J({ error: 'bad_dev' }, 400);
        const ll = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);
        const lat = ll(b.lat), lng = ll(b.lng), day = new Date().toISOString().slice(0, 10);
        await env.DB.prepare('INSERT INTO visits(dev,day,country,region,city,lat,lng,created) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dev,day) DO UPDATE SET lat=COALESCE(excluded.lat,lat), lng=COALESCE(excluded.lng,lng)')
          .bind(dev, day, clean(cf.country, 3), clean(cf.region, 60), clean(cf.city, 60), lat, lng, Date.now()).run();
        return J({ ok: true });
      }
      if (p === '/api/session' && m === 'POST') {
        const b = await body(req); let sub, name = clean(b.name, 60), prev = await verify(env, b.prev);
        if (b.via === 'google') {
          const g = await fetch(env.GOOGLE_USERINFO || 'https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: 'Bearer ' + clean(b.at, 4000) } });
          const u = g.ok ? await g.json() : null;
          if (!u || !u.email || u.email_verified === false) return J({ error: 'google_failed' }, 401);
          sub = 'g:' + String(u.email).toLowerCase(); name = name || clean(u.name, 60);
          if (prev && prev.r === 'user' && prev.sub.startsWith('d:')) await env.DB.prepare('UPDATE invoices SET owner=? WHERE owner=?').bind(sub, prev.sub).run();
        } else {
          sub = prev && prev.r === 'user' ? prev.sub : 'd:' + b64u(crypto.getRandomValues(new Uint8Array(18)));
        }
        return J({ tok: await sign(env, { r: 'user', sub, exp: Date.now() + 180 * 864e5 }) });
      }
      if (p === '/api/chat' && m === 'POST') return await chat(env, req);
      if (p === '/api/lookup' && m === 'POST') {
        const ip = req.headers.get('cf-connecting-ip') || 'local';
        if (await limited(env, ip, 'look', 30)) return J({ error: 'rate' }, 429);
        const b = await body(req), no = clean(b.no, 40).toUpperCase().replace(/\s+/g, ''), ph = last10(b.phone);
        if (!no && ph.length < 8) return J({ error: 'bad_request' }, 400);
        const cols = 'no,name,phone,city,addr,design,size,slot,total,dep,method,kind,status,created,confirmed_at';
        let rows = [];
        if (no) { const r = await env.DB.prepare(`SELECT ${cols} FROM invoices WHERE no=?`).bind(no).first(); if (r) rows = [r]; }
        else rows = (await env.DB.prepare(`SELECT ${cols} FROM invoices WHERE substr(phone,-10)=? ORDER BY id DESC LIMIT 5`).bind(ph).all()).results;
        const full = !!(no && ph.length >= 8 && rows[0] && last10(rows[0].phone) === ph);
        const out = rows.map((r) => full ? r : { no: r.no, design: r.design, size: r.size, total: r.total, dep: r.dep, kind: r.kind, status: r.status, created: r.created, confirmed_at: r.confirmed_at, name: maskName(r.name), phone: maskPh(r.phone) });
        return J({ full, invoices: out });
      }
      if (p === '/api/invoice-file' && m === 'POST') {
        const ip = req.headers.get('cf-connecting-ip') || 'local';
        if (await limited(env, ip, 'up', 40)) return J({ error: 'rate' }, 429);
        const no = clean(url.searchParams.get('no'), 40).toUpperCase(), ph = last10(url.searchParams.get('phone')), kind = url.searchParams.get('kind') === 'transfer' ? 'transfer' : 'other';
        const inv = await env.DB.prepare('SELECT no,phone,owner FROM invoices WHERE no=?').bind(no).first();
        if (!inv) return J({ error: 'not_found' }, 404);
        const u = await userOf(env, req);
        if (!((ph.length >= 8 && last10(inv.phone) === ph) || (u && u.sub === inv.owner))) return J({ error: 'forbidden' }, 403);
        const mime = (req.headers.get('content-type') || '').split(';')[0];
        if (!/^image\/(jpeg|png|webp)$/.test(mime)) return J({ error: 'bad_type' }, 415);
        const buf = await req.arrayBuffer(); if (!buf.byteLength) return J({ error: 'empty' }, 400); if (buf.byteLength > 1.5 * 1048576) return J({ error: 'too_big' }, 413);
        const c = await env.DB.prepare('SELECT COUNT(*) n FROM invoice_files WHERE no=?').bind(no).first(); if (c.n >= 6) return J({ error: 'limit' }, 409);
        const id = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((x) => x.toString(16).padStart(2, '0')).join('');
        await env.DB.prepare('INSERT INTO invoice_files(id,no,kind,mime,data,created) VALUES(?,?,?,?,?,?)').bind(id, no, kind, mime, buf, Date.now()).run();
        return J({ ok: true, count: c.n + 1 });
      }
      // ---------- customer (session required) ----------
      if (p === '/api/order' && m === 'POST') {
        const u = await userOf(env, req); if (!u) return J({ error: 'auth' }, 401);
        const b = await body(req), kind = ['booking', 'inquiry', 'merge'].includes(b.kind) ? b.kind : 'inquiry';
        let no = null; const cid = clean(b.cid, 30).toUpperCase();
        if (/^INV-\d{6}-\d{4}$/.test(cid) && !(await env.DB.prepare('SELECT 1 x FROM invoices WHERE no=?').bind(cid).first())) no = cid;
        const tmp = no || 'TMP-' + b64u(crypto.getRandomValues(new Uint8Array(9)));
        const r = await env.DB.prepare('INSERT INTO invoices(no,owner,name,phone,city,addr,design,size,slot,total,dep,method,kind,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(tmp, u.sub, clean(b.name, 60), digits(b.phone), clean(b.city, 60), clean(b.addr, 200), clean(b.design, 120), clean(b.size, 60), clean(b.slot, 40), num(b.total), num(b.dep), clean(b.method, 40), kind, 'pending', Date.now()).run();
        if (!no) { no = 'INV-' + (1000 + Number(r.meta.last_row_id)); await env.DB.prepare('UPDATE invoices SET no=? WHERE id=?').bind(no, r.meta.last_row_id).run(); }
        return J({ no });
      }
      if (p === '/api/my-invoice' && m === 'GET') {
        const u = await userOf(env, req); if (!u) return J({ error: 'auth' }, 401);
        const r = await env.DB.prepare('SELECT no,name,phone,city,addr,design,size,slot,total,dep,method,kind,status,created,confirmed_at FROM invoices WHERE owner=? ORDER BY id DESC LIMIT 1').bind(u.sub).first();
        return J({ invoice: r || null });
      }
      // ---------- admin ----------
      if (p === '/api/admin/login' && m === 'POST') {
        const ip = req.headers.get('cf-connecting-ip') || 'local', now = Date.now();
        await env.DB.prepare('DELETE FROM attempts WHERE t<?').bind(now - 900000).run();
        const c = await env.DB.prepare('SELECT COUNT(*) n FROM attempts WHERE ip=?').bind(ip).first();
        if (c.n >= 8) return J({ error: 'locked' }, 429);
        const b = await body(req);
        if (!(await checkPassword(env, String(b.password || '')))) { await env.DB.prepare('INSERT INTO attempts(ip,t) VALUES(?,?)').bind(ip, now).run(); return J({ error: 'bad_password' }, 401); }
        const name = clean(b.name, 40) || 'المالك';
        return J({ tok: await sign(env, { r: 'admin', n: name, exp: now + 12 * 3600e3 }), name });
      }
      if (p.startsWith('/api/admin/')) {
        const a = await adminOf(env, req); if (!a) return J({ error: 'auth' }, 401);
        if (p === '/api/admin/studio' && m === 'PUT') {
          const b = await body(req); if (!b.state || !Array.isArray(b.state.cats)) return J({ error: 'bad_state' }, 400);
          const cur = await env.DB.prepare("SELECT v FROM kv WHERE k='studio'").first(), o = cur ? JSON.parse(cur.v) : null;
          if (o && !b.force && +b.base !== o.rev) return J({ error: 'conflict', rev: o.rev }, 409);
          const rev = (o ? o.rev : 0) + 1, st = stripPublic(b.state); st.rev = rev;
          await env.DB.prepare("INSERT INTO kv(k,v) VALUES('studio',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify({ rev, state: st })).run();
          return J({ rev });
        }
        if (p === '/api/admin/img' && m === 'POST') {
          const mime = (req.headers.get('content-type') || '').split(';')[0];
          if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return J({ error: 'bad_type' }, 415);
          const buf = await req.arrayBuffer(); if (buf.byteLength > 1.5 * 1048576) return J({ error: 'too_big' }, 413);
          if (!buf.byteLength) return J({ error: 'empty' }, 400);
          const id = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((x) => x.toString(16).padStart(2, '0')).join('');
          await env.DB.prepare('INSERT INTO images(id,mime,data,created) VALUES(?,?,?,?)').bind(id, mime, buf, Date.now()).run();
          return J({ id });
        }
        if (p === '/api/admin/stats' && m === 'GET') {
          const q = (s) => env.DB.prepare(s).first();
          const [v, o, c, un] = await Promise.all([q('SELECT COUNT(*) n FROM visits'), q('SELECT COUNT(*) n FROM invoices'), q("SELECT COUNT(*) n FROM invoices WHERE status='confirmed'"), q("SELECT COUNT(*) n FROM invoices WHERE status!='confirmed'")]);
          const L = await env.DB.prepare("SELECT COALESCE(NULLIF(city,''),NULLIF(region,''),NULLIF(country,''),'غير معروف') place, NULLIF(country,'') country, COUNT(*) n FROM visits GROUP BY 1,2 ORDER BY n DESC LIMIT 5").all();
          return J({ visits: v.n, locations: L.results, orders: o.n, confirmed: c.n, unconfirmed: un.n });
        }
        if (p === '/api/admin/invoice-files' && m === 'GET') {
          const r = await env.DB.prepare('SELECT id,kind,created FROM invoice_files WHERE no=? ORDER BY created').bind(clean(url.searchParams.get('no'), 40).toUpperCase()).all(); return J({ files: r.results });
        }
        if (p.startsWith('/api/admin/file/') && m === 'GET') {
          const r = await env.DB.prepare('SELECT mime,data FROM invoice_files WHERE id=?').bind(p.slice(16)).first(); if (!r) return J({ error: 'not_found' }, 404);
          const d = r.data, bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : Array.isArray(d) ? Uint8Array.from(d) : new Uint8Array(d);
          return new Response(bytes, { headers: { 'content-type': r.mime, 'cache-control': 'private, no-store' } });
        }
        if (p === '/api/admin/pending' && m === 'GET') {
          const r = await env.DB.prepare("SELECT no,name,total,(SELECT COUNT(*) FROM invoice_files f WHERE f.no=invoices.no) files FROM invoices WHERE status!='confirmed' ORDER BY id DESC LIMIT 15").all(); return J({ list: r.results });
        }
        if (p === '/api/admin/confirm' && m === 'POST') {
          const b = await body(req), no = clean(b.no, 40).toUpperCase().replace(/\s+/g, '');
          if (!/^[A-Z0-9_-]{3,40}$/.test(no)) return J({ error: 'bad_number' }, 400);
          const r = await env.DB.prepare('SELECT no,status,confirmed_at,confirmed_by,name,total FROM invoices WHERE no=?').bind(no).first();
          if (!r) return J({ error: 'not_found' }, 404);
          if (r.status === 'confirmed') return J({ already: true, no, at: r.confirmed_at, by: r.confirmed_by });
          const at = Date.now();
          await env.DB.prepare("UPDATE invoices SET status='confirmed', confirmed_at=?, confirmed_by=? WHERE no=? AND status!='confirmed'").bind(at, a.n, no).run();
          return J({ ok: true, no, at, by: a.n, name: r.name, total: r.total });
        }
        if (p === '/api/admin/password' && m === 'POST') {
          const b = await body(req), pw = String(b.password || ''); if (pw.length < 8) return J({ error: 'short' }, 400);
          const salt = crypto.getRandomValues(new Uint8Array(16));
          await env.DB.prepare("INSERT INTO kv(k,v) VALUES('admin_pw',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(b64u(salt) + ':' + (await pbkdf2(pw, salt))).run();
          return J({ ok: true });
        }
      }
      return J({ error: 'not_found' }, 404);
    } catch (e) { return J({ error: 'server', msg: String(e && e.message || e) }, 500); }
  },
};
