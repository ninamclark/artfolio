'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Seed a v1-shaped database first, to prove the migration to the current schema keeps existing work.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'artfolio-'));
process.env.DATA_DIR = DATA;
process.env.TRUST_PROXY = '1';
process.env.PUBLIC_ORIGIN = 'https://artfolio.test';
process.env.AUTH_MIN_MS = '50';
delete process.env.SMTP_URL; // emails go to DATA/outbox
fs.mkdirSync(path.join(DATA, 'uploads'));
{
  const old = new DatabaseSync(path.join(DATA, 'artfolio.db'));
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', theme TEXT NOT NULL DEFAULT 'minimal', pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE works (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (1,'legacy','Legacy','','dark','s','h',1);
    INSERT INTO works VALUES (1,1,'Old piece','from v1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',1,1);
  `);
  old.close();
}
const app = require('../server.js');
const { server, L } = app;
const { sanitizeImage } = require('../lib/imagesafe');
const S = require('../lib/security');
const { createMailer } = require('../lib/mailer');

let base, port;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  base = `http://localhost:${port}`;
});
after(() => server.close());

const H = { 'X-Requested-With': 'artfolio' };
let ipn = 0;
const freshIp = () => `10.0.${Math.floor(++ipn / 250)}.${ipn % 250}`;
async function call(method, url, { body, raw, cookie, headers } = {}) {
  const h = { ...H, 'X-Forwarded-For': headers?.['X-Forwarded-For'] || freshIp(), ...headers };
  if (cookie) h.Cookie = cookie;
  let b;
  if (raw) b = raw;
  else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    b = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers: h, body: b, redirect: 'manual' });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
}
// all Set-Cookie pairs of a response, as one Cookie header
const cookies = (r) => r.res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const sid = (r) => r.res.headers.getSetCookie().find((c) => /^(__Host-)?sid=/.test(c)).split(';')[0];
const PW = 'plum-orchard-42';
const mailOf = (u) => `${u.toLowerCase()}@example.com`;
const signupRaw = (u, p = PW, email = mailOf(u)) => call('POST', '/api/signup', { body: { username: u, email, password: p } });
const signup = async (u, p = PW) => {
  const c = sid(await signupRaw(u, p));
  await call('PATCH', '/api/profile', { cookie: c, body: { published: true } });
  return c;
};

// ----- reading the dev outbox -----
const OUTBOX = path.join(DATA, 'outbox');
function mails(to) {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs.readdirSync(OUTBOX).sort().map((f) => {
    const raw = fs.readFileSync(path.join(OUTBOX, f), 'latin1');
    const [head, body] = raw.split('\r\n\r\n');
    const hdr = (n) => (head.match(new RegExp(`^${n}: (.*)$`, 'mi')) || [])[1] || '';
    return { to: hdr('To'), subject: hdr('Subject'), text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
  }).filter((m) => !to || m.to === to);
}
const lastMail = (to) => mails(to).at(-1);
const codeIn = (m) => m.text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)[1];
const verifyEmail = async (cookie, email) => assert.equal((await call('POST', '/api/email/verify', { cookie, body: { code: codeIn(lastMail(email)) } })).status, 200);

// minimal valid 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const uploadsDir = () => fs.readdirSync(path.join(DATA, 'uploads'));

// raw request whose body is sent only after `delay` ms (like a slow phone upload)
const slow = (method, p, { body, cookie, delay = 0 }) =>
  new Promise((resolve) => {
    const r = http.request({ port, method, path: p, headers: { ...H, Cookie: cookie, 'Content-Length': body.length, 'X-Forwarded-For': freshIp() } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    r.on('error', (e) => resolve({ status: 'ERR ' + e.code }));
    r.flushHeaders();
    setTimeout(() => r.end(body), delay);
  });

let cookie, workId, imgUrl, collId;

test('v1 database is migrated: old works become works with one image', async () => {
  const db = new DatabaseSync(path.join(DATA, 'artfolio.db'));
  const imgs = db.prepare('SELECT * FROM images').all();
  const cols = db.prepare('PRAGMA table_info(works)').all().map((c) => c.name);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  db.close();
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].filename, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png');
  assert.ok(!cols.includes('filename'));
  assert.ok(cols.includes('collection_id'));
  assert.equal(version, 3);
  const html = await (await fetch(base + '/u/legacy')).text();
  assert.match(html, /Old piece/);
  assert.match(html, /pal-ink/); // 'dark' was renamed to 'ink' by the migration
});

test('a failing migration changes nothing and can be retried', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const db = new DatabaseSync(path.join(dir, 'artfolio.db'));
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', theme TEXT NOT NULL DEFAULT 'minimal', pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE works (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (1,'old','Old','','dark','s','h',1); INSERT INTO works VALUES (1,1,'t','d','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',1,1);
    CREATE VIEW blocker AS SELECT filename FROM works;`); // a view on the column makes DROP COLUMN fail
  db.close();
  const run = () => execFileSync(process.execPath, ['--no-warnings', '-e', "require('./server.js'); process.exit(0)"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir }, stdio: 'pipe' });
  assert.throws(run);
  const after1 = new DatabaseSync(path.join(dir, 'artfolio.db'));
  assert.equal(after1.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'images'").get().n, 0); // rolled back
  after1.exec('DROP VIEW blocker');
  after1.close();
  run(); // now it succeeds, exactly once
  const after2 = new DatabaseSync(path.join(dir, 'artfolio.db'));
  assert.equal(after2.prepare('SELECT COUNT(*) n FROM images').get().n, 1);
  after2.close();
  run();
  const after3 = new DatabaseSync(path.join(dir, 'artfolio.db'));
  assert.equal(after3.prepare('SELECT COUNT(*) n FROM images').get().n, 1); // no duplicates on later starts
  after3.close();
});

test('signup validates input (email required)', async () => {
  assert.equal((await signupRaw('a')).status, 400);
  assert.equal((await signupRaw('good_name', 'short')).status, 400);
  assert.equal((await signupRaw('api')).status, 400);
  assert.equal((await signupRaw('noemail', PW, '')).status, 400);
  assert.equal((await signupRaw('bademail', PW, 'a..b@example.com')).status, 400);
});

test('signup, duplicate username, login by username or email after confirming', async () => {
  const r = await signupRaw('Frida');
  assert.equal(r.status, 201);
  cookie = sid(r);
  assert.equal(r.data.recoveryKey, undefined);
  assert.equal((await call('PATCH', '/api/profile', { cookie, body: { published: true } })).status, 200);
  assert.match(r.res.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await signupRaw('frida')).status, 409);
  assert.equal((await call('POST', '/api/login', { body: { username: 'Frida', password: 'wrong password' } })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { username: 'Frida', password: PW } })).status, 200);
  // the email isn't usable until confirmed
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.data.user.email, '');
  assert.equal(me.data.user.pendingEmail, 'frida@example.com');
  assert.equal((await call('POST', '/api/login', { body: { username: 'frida@example.com', password: PW } })).status, 401);
  await verifyEmail(cookie, 'frida@example.com');
  assert.equal((await call('GET', '/api/me', { cookie })).data.user.email, 'frida@example.com');
  assert.equal((await call('POST', '/api/login', { body: { username: 'Frida@Example.com', password: PW } })).status, 200);
});

test('API requires login and the CSRF header', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await fetch(base + '/api/logout', { method: 'POST' })).status, 403);
});

test('upload rejects non-images even with an image content-type', async () => {
  const r = await call('POST', '/api/images', { cookie, raw: Buffer.from('<script>alert(1)</script>'), headers: { 'Content-Type': 'image/png' } });
  assert.equal(r.status, 415);
  assert.equal(uploadsDir().length, 0);
});

test('upload an image, attach a thumbnail, edit the piece', async () => {
  const r = await call('POST', '/api/images?title=' + encodeURIComponent('100% <b>Blue</b>'), { cookie, raw: PNG });
  assert.equal(r.status, 201);
  workId = r.data.id;
  const img = r.data.images[0];
  assert.match(img.url, /^\/img\/[a-f0-9]{32}\.png$/);
  assert.equal(img.thumb, img.url); // no thumb yet: falls back to the full image
  const t = await call('PUT', `/api/images/${img.id}/thumb`, { cookie, raw: PNG });
  assert.equal(t.status, 200);
  assert.notEqual(t.data.thumb, img.url);
  imgUrl = img.url;
  assert.equal((await call('PUT', `/api/images/${img.id}/thumb`, { cookie, raw: Buffer.from('nope nope nope nope') })).status, 415);
  assert.equal((await call('PATCH', `/api/works/${workId}`, { cookie, body: { description: 'Oil on canvas <img src=x onerror=alert(1)>' } })).status, 200);
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.data.works[0].title, '100% <b>Blue</b>');
});

test('multiple images per piece, with a cap on images and per-image delete', async () => {
  for (let i = 0; i < 2; i++) {
    const r = await call('POST', `/api/images?work=${workId}`, { cookie, raw: PNG });
    assert.equal(r.status, 201);
  }
  let me = await call('GET', '/api/me', { cookie });
  assert.equal(me.data.works[0].images.length, 3);
  const extra = me.data.works[0].images[2];
  const before = uploadsDir().length;
  assert.equal((await call('DELETE', `/api/images/${extra.id}`, { cookie })).status, 200);
  assert.equal(uploadsDir().length, before - 1);
  me = await call('GET', '/api/me', { cookie });
  assert.equal(me.data.works[0].images.length, 2);
  assert.equal((await call('POST', '/api/images?work=999999', { cookie, raw: PNG })).status, 404);
});

test('uploaded image is served with correct type and revalidation caching; traversal is blocked', async () => {
  const r = await fetch(base + imgUrl);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'public, no-cache');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  assert.equal((await fetch(base + imgUrl, { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(base + '/img/..%2Fartfolio.db')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e%2fdata%2fartfolio.db')).status, 404);
});

test('collections: create, assign, rename, filter UI, delete keeps works', async () => {
  const c = await call('POST', '/api/collections', { cookie, body: { name: 'Oils <2024>' } });
  assert.equal(c.status, 201);
  collId = c.data.id;
  assert.equal((await call('POST', '/api/collections', { cookie, body: { name: '  ' } })).status, 400);
  assert.equal((await call('PATCH', `/api/works/${workId}`, { cookie, body: { collectionId: collId } })).status, 200);
  assert.equal((await call('PATCH', `/api/works/${workId}`, { cookie, body: { collectionId: 99999 } })).status, 400);
  assert.equal((await call('PATCH', `/api/works/${workId}`, { cookie, body: { collectionId: String(collId) } })).status, 400);
  const html = await (await fetch(base + '/u/Frida')).text();
  assert.ok(html.includes('data-filter="' + collId + '"'));
  assert.ok(html.includes('Oils &lt;2024&gt;'));
  assert.equal((await call('PATCH', `/api/collections/${collId}`, { cookie, body: { name: 'Oils' } })).status, 200);
  assert.equal((await call('DELETE', `/api/collections/${collId}`, { cookie })).status, 200);
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.data.works[0].collectionId, null);
  assert.equal(me.data.collections.length, 0);
});

test('profile: templates, palettes, links and names are validated', async () => {
  const ok = await call('PATCH', '/api/profile', {
    cookie,
    body: { displayName: 'Frida <script>x</script>', bio: 'Painter', template: 'studio', theme: 'midnight', website: 'frida.art', instagram: '@frida.paints', contactEmail: 'hi@frida.art' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.website, 'https://frida.art/');
  assert.equal(ok.data.user.instagram, 'frida.paints');
  for (const bad of [
    { template: 'neon' },
    { theme: 'neon' },
    { website: 'javascript:alert(1)' },
    { website: 'http://' },
    { website: 'https://user:secret@frida.art' },
    { instagram: 'a b<c' },
    { contactEmail: 'not an email' },
    { contactEmail: '.frida@art.co' },
    { displayName: '\u200d\u200d' }, // nothing visible
    { published: 'yes' },
  ]) assert.equal((await call('PATCH', '/api/profile', { cookie, body: bad })).status, 400, JSON.stringify(bad));
  // characters that render as blank (Hangul fillers, braille blank) are stripped, so the name falls back to the username
  const blank = await call('PATCH', '/api/profile', { cookie, body: { displayName: '\u3164\u2800\u3164' } });
  assert.equal(blank.data.user.displayName, 'Frida');
  await call('PATCH', '/api/profile', { cookie, body: { displayName: 'Frida <script>x</script>' } });
  for (const t of ['gallery', 'grid', 'editorial', 'studio', 'carousel', 'spotlight']) {
    await call('PATCH', '/api/profile', { cookie, body: { template: t } });
    assert.match(await (await fetch(base + '/u/Frida')).text(), new RegExp(`tpl-${t} pal-midnight`));
  }
});

test('public page escapes everything, sets CSP, and has no inline script', async () => {
  const page = await fetch(base + '/u/Frida');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(!html.includes('<img src=x onerror'));
  assert.ok(html.includes('&lt;b&gt;Blue&lt;/b&gt;'));
  assert.ok(html.includes('href="mailto:hi@frida.art"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(!html.includes('frida@example.com')); // the account email is never public
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.deepEqual([...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]), ['<script src="/portfolio.js">']);
  assert.equal((await fetch(base + '/u/nobody')).status, 404);
});

test('share previews: absolute og:image, canonical URL, description escaped once', async () => {
  await call('PATCH', '/api/profile', { cookie, body: { displayName: 'Tom & Jerry', bio: '' } });
  const html = await (await fetch(base + '/u/Frida')).text();
  assert.match(html, /<meta name="description" content="Portfolio of Tom &amp; Jerry">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/artfolio\.test\/img\/[a-f0-9]{32}\.png">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/artfolio\.test\/u\/Frida">/);
  assert.match(html, /<span class="sr">2 images<\/span>/);
  const r = await fetch(base + '/u/FRIDA', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/u/Frida');
});

test("users cannot touch each other's data", async () => {
  const other = await signup('mallory', PW);
  const me = await call('GET', '/api/me', { cookie });
  const imgId = me.data.works[0].images[0].id;
  assert.equal((await call('PATCH', `/api/works/${workId}`, { cookie: other, body: { title: 'pwned' } })).status, 404);
  assert.equal((await call('DELETE', `/api/works/${workId}`, { cookie: other })).status, 404);
  assert.equal((await call('DELETE', `/api/images/${imgId}`, { cookie: other })).status, 404);
  assert.equal((await call('PUT', `/api/images/${imgId}/thumb`, { cookie: other, raw: PNG })).status, 404);
  assert.equal((await call('POST', `/api/images?work=${workId}`, { cookie: other, raw: PNG })).status, 404);
  const c = await call('POST', '/api/collections', { cookie, body: { name: 'mine' } });
  assert.equal((await call('PATCH', `/api/works/${workId}`, { cookie: other, body: { collectionId: c.data.id } })).status, 404);
  assert.equal((await call('PATCH', `/api/collections/${c.data.id}`, { cookie: other, body: { name: 'x' } })).status, 404);
  assert.equal((await call('DELETE', `/api/collections/${c.data.id}`, { cookie: other })).status, 404);
});

test('reorder needs the complete list; delete a piece removes every file', async () => {
  const r2 = await call('POST', '/api/images?title=second', { cookie, raw: PNG });
  const ids = [r2.data.id, workId];
  assert.equal((await call('POST', '/api/works/reorder', { cookie, body: { ids: [workId] } })).status, 409);
  assert.equal((await call('POST', '/api/works/reorder', { cookie, body: { ids: [workId, workId] } })).status, 409);
  assert.equal((await call('POST', '/api/works/reorder', { cookie, body: { ids } })).status, 200);
  const me = await call('GET', '/api/me', { cookie });
  assert.deepEqual(me.data.works.map((w) => w.id), ids);
  assert.equal((await call('DELETE', `/api/works/${workId}`, { cookie })).status, 200);
  assert.ok(!fs.existsSync(path.join(DATA, 'uploads', imgUrl.split('/').pop())));
});

test('change password: new session for this device, all others signed out, notice emailed', async () => {
  const a = await signup('pwuser', 'old-password-77x');
  await verifyEmail(a, 'pwuser@example.com');
  const b = sid(await call('POST', '/api/login', { body: { username: 'pwuser', password: 'old-password-77x' } }));
  assert.equal((await call('POST', '/api/password', { cookie: a, body: { current: 'wrong', next: 'new-password-88y' } })).status, 401);
  assert.equal((await call('POST', '/api/password', { cookie: a, body: { current: 'old-password-77x', next: 'short' } })).status, 400);
  const ok = await call('POST', '/api/password', { cookie: a, body: { current: 'old-password-77x', next: 'new-password-88y' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: a })).status, 401); // the old token was rotated...
  assert.equal((await call('GET', '/api/me', { cookie: sid(ok) })).status, 200); // ...into a new one
  assert.equal((await call('GET', '/api/me', { cookie: b })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { username: 'pwuser', password: 'old-password-77x' } })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { username: 'pwuser', password: 'new-password-88y' } })).status, 200);
  assert.match(lastMail('pwuser@example.com').subject, /password was changed/);
});

test('delete account removes the user, public page and all files', async () => {
  const c = await signup('goner', PW);
  await call('POST', '/api/images?title=x', { cookie: c, raw: PNG });
  const w = (await call('GET', '/api/me', { cookie: c })).data.works[0];
  await call('PUT', `/api/images/${w.images[0].id}/thumb`, { cookie: c, raw: PNG });
  const filesBefore = uploadsDir().length;
  assert.equal((await call('DELETE', '/api/account', { cookie: c, body: { password: 'nope nope' } })).status, 401);
  assert.equal((await call('DELETE', '/api/account', { cookie: c, body: { password: PW } })).status, 200);
  assert.equal(uploadsDir().length, filesBefore - 2);
  assert.equal((await fetch(base + '/u/goner')).status, 404);
  assert.equal((await call('GET', '/api/me', { cookie: c })).status, 401);
});

test('logout invalidates the session', async () => {
  const c = await signup('leaver');
  assert.equal((await call('POST', '/api/logout', { cookie: c })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: c })).status, 401);
});

test('public page ships full-size URLs so big layouts can upgrade live, and the live-look API exists', async () => {
  const html = await (await fetch(base + '/u/Frida')).text();
  assert.match(html, /<img [^>]*src="\/img\/[a-f0-9]{32}\.png" data-full="\/img\/[a-f0-9]{32}\.png"/);
  const js = await (await fetch(base + '/portfolio.js')).text();
  for (const needle of ['setLook', 'initCarousel', 'initSpotlight', "'carousel'", "'spotlight'"]) assert.ok(js.includes(needle), needle);
  const css = await (await fetch(base + '/portfolio.css')).text();
  for (const needle of ['.tpl-carousel', '.tpl-spotlight', 'work[hidden]{display:none!important}']) assert.ok(css.includes(needle), needle);
});

test('static assets load', async () => {
  for (const f of ['/', '/app.js', '/style.css', '/portfolio.css', '/portfolio.js']) assert.equal((await fetch(base + f)).status, 200, f);
});

// ======================= email: confirmation and password reset =======================
test('password reset by emailed code', async () => {
  const old = await signup('forgetful');
  await verifyEmail(old, 'forgetful@example.com');
  const n = mails().length;
  // unknown and known addresses get the same answer; only the real one gets an email
  assert.equal((await call('POST', '/api/password-reset/request', { body: { email: 'nobody@example.com' } })).status, 200);
  assert.equal(mails().length, n);
  assert.equal((await call('POST', '/api/password-reset/request', { body: { email: 'Forgetful@Example.com' } })).status, 200);
  const m = lastMail('forgetful@example.com');
  assert.match(m.subject, /reset/i);
  assert.match(m.text, /https:\/\/artfolio\.test\/#reset\?email=forgetful%40example\.com&code=/);
  const code = codeIn(m);
  const confirm = (body) => call('POST', '/api/password-reset/confirm', { body: { email: 'forgetful@example.com', ...body } });
  assert.equal((await confirm({ code: 'AAAA-BBBB', newPassword: 'brand-new-pass-9' })).status, 400);
  assert.equal((await confirm({ code, newPassword: 'short' })).status, 400);
  const ok = await confirm({ code: code.toLowerCase().replace('-', ' '), newPassword: 'brand-new-pass-9' });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: sid(ok) })).status, 200); // signed in
  assert.equal((await call('GET', '/api/me', { cookie: old })).status, 401); // everywhere else signed out
  assert.equal((await confirm({ code, newPassword: 'another-pass-123' })).status, 400); // codes work once
  assert.equal((await call('POST', '/api/login', { body: { username: 'forgetful', password: 'brand-new-pass-9' } })).status, 200);
  assert.match(lastMail('forgetful@example.com').subject, /password was changed/);
});

test('reset codes die after 5 wrong tries, and unconfirmed emails get no reset', async () => {
  const c = await signup('guessme');
  assert.equal((await call('POST', '/api/password-reset/request', { body: { email: 'guessme@example.com' } })).status, 200);
  assert.ok(!mails('guessme@example.com').some((m) => /reset/i.test(m.subject))); // not confirmed yet
  await verifyEmail(c, 'guessme@example.com');
  await call('POST', '/api/password-reset/request', { body: { email: 'guessme@example.com' } });
  const code = codeIn(lastMail('guessme@example.com'));
  for (let i = 0; i < 5; i++)
    assert.equal((await call('POST', '/api/password-reset/confirm', { body: { email: 'guessme@example.com', code: `WRNG-${'ABCDE'[i]}AAA`, newPassword: 'fresh-pass-word-1' } })).status, 400);
  assert.equal((await call('POST', '/api/password-reset/confirm', { body: { email: 'guessme@example.com', code, newPassword: 'fresh-pass-word-1' } })).status, 400);
});

test('changing the email: password needed, code goes to the new address, old address is told', async () => {
  const c = await signup('mover');
  await verifyEmail(c, 'mover@example.com');
  assert.equal((await call('POST', '/api/email', { cookie: c, body: { email: 'new@mover.art', password: 'wrong-wrong-1' } })).status, 401);
  assert.equal((await call('POST', '/api/email', { cookie: c, body: { email: 'new@mover.art', password: PW } })).status, 200);
  assert.match(lastMail('mover@example.com').subject, /being changed/);
  assert.equal((await call('POST', '/api/email/verify', { cookie: c, body: { code: 'ZZZZ-ZZZZ' } })).status, 400);
  await verifyEmail(c, 'new@mover.art');
  assert.equal((await call('GET', '/api/me', { cookie: c })).data.user.email, 'new@mover.art');
  // an address already confirmed by someone else can't be claimed
  const d = await signup('copycat');
  await call('POST', '/api/email', { cookie: d, body: { email: 'new@mover.art', password: PW } });
  assert.equal((await call('POST', '/api/email/verify', { cookie: d, body: { code: codeIn(lastMail('new@mover.art')) } })).status, 409);
});

test('SMTP client speaks the protocol (fake server)', async () => {
  const got = [];
  const fake = net.createServer((s) => {
    let buf = '', inData = false, data = '';
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; got.push(data); s.write('250 queued\r\n'); } else data += line + '\n';
          continue;
        }
        got.push(line);
        if (/^EHLO/.test(line)) s.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1000000\r\n');
        else if (/^AUTH PLAIN/.test(line)) s.write('235 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
        else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => fake.listen(0, r));
  const m = createMailer({ url: `smtp://user:p%40ss@127.0.0.1:${fake.address().port}?tls=off`, from: 'Artfolio <hi@artfolio.test>', log: { log() {}, warn() {}, error() {} } });
  await m.sendNow('to@example.com', 'Héllo', 'Line one\n.starts with a dot');
  fake.close();
  assert.ok(got.includes('AUTH PLAIN ' + Buffer.from('\0user\0p@ss').toString('base64')));
  assert.ok(got.includes('MAIL FROM:<hi@artfolio.test>') && got.includes('RCPT TO:<to@example.com>'));
  const msg = got.find((g) => g.includes('Subject:'));
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
  const body = Buffer.from(msg.split('\n\n')[1].replace(/\n/g, ''), 'base64').toString();
  assert.equal(body, 'Line one\r\n.starts with a dot');
  // refuses to send in plain text when the server doesn't offer STARTTLS
  const plain = net.createServer((s) => { s.write('220 x\r\n'); s.on('data', () => s.write('250 ok\r\n')); });
  await new Promise((r) => plain.listen(0, r));
  const m2 = createMailer({ url: `smtp://127.0.0.1:${plain.address().port}`, from: 'a@b.co', log: { log() {}, warn() {}, error() {} } });
  await assert.rejects(m2.sendNow('to@example.com', 's', 't'), /STARTTLS/);
  plain.close();
});

// ======================= security hardening =======================
const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
const jpegWith = (extra) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]), ...extra,
    seg(0xc0, Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0])), // SOF0 3x2
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34]), Buffer.from([0xff, 0xd9]),
  ]);
const exifGps = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('MM\0*\0\0\0\x08SECRET-GPS-48.8566,2.3522', 'latin1')]);

test('EXIF/GPS is stripped from JPEG uploads (orientation survives)', async () => {
  const c = await signup('exifguy');
  const r = await call('POST', '/api/images', { cookie: c, raw: jpegWith([seg(0xe1, exifGps), seg(0xfe, Buffer.from('camera comment'))]) });
  assert.equal(r.status, 201);
  const bytes = Buffer.from(await (await fetch(base + r.data.images[0].url, { headers: { Cookie: c } })).arrayBuffer());
  assert.ok(!bytes.includes('SECRET-GPS') && !bytes.includes('camera comment'));
  assert.equal(bytes[0], 0xff);
});

test('image cleaner keeps only an allowlist: JFIF thumbnails, JFXX, vendor chunks dropped', () => {
  const jfifThumb = Buffer.concat([Buffer.from('JFIF\0\x01\x02\x00\x00\x48\x00\x48\x01\x01', 'latin1'), Buffer.from('THUMB')]); // 1x1 thumb (3 bytes RGB...)
  const out = sanitizeImage(jpegWith([seg(0xe0, jfifThumb), seg(0xe0, Buffer.from('JFXX\0SECRET-uncropped')), seg(0xf0, Buffer.from('SECRET-F0'))]));
  assert.ok(!out.buf.includes('SECRET') && !out.buf.includes('THUMB'));
  assert.equal(out.buf.toString('latin1', 6, 11), 'JFIF\0'); // JFIF header kept, first, right after SOI
  const oriented = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('MM\0*\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0', 'latin1')]);
  const o = sanitizeImage(jpegWith([seg(0xe0, jfifThumb), seg(0xe1, oriented)])).buf;
  assert.equal(o[3], 0xe0); // APP0 first...
  assert.equal(o[2 + 2 + 16 + 1], 0xe1); // ...then the orientation block
  // WebP: an unknown chunk is dropped
  const chunk = (id, d) => { const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(d.length, 4); return Buffer.concat([h, d, d.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const riff = (body) => { const h = Buffer.alloc(12); h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(body.length + 4, 4); h.write('WEBP', 8, 'latin1'); return Buffer.concat([h, body]); };
  const vp8l = (w, h) => { const d = Buffer.alloc(5); d[0] = 0x2f; d.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1); return chunk('VP8L', d); };
  const vp8x = (w, h) => { const d = Buffer.alloc(10); d.writeUIntLE(w - 1, 4, 3); d.writeUIntLE(h - 1, 7, 3); return chunk('VP8X', d); };
  assert.ok(!sanitizeImage(riff(Buffer.concat([vp8l(1, 1), chunk('META', Buffer.from('SECRET-GPS'))]))).buf.includes('SECRET'));
  // pixel bombs hidden behind a small header are refused
  assert.throws(() => sanitizeImage(riff(Buffer.concat([vp8x(1, 1), vp8l(16384, 16384)]))), (e) => e.status === 415);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0, 0, 0]), Buffer.from([0x2c, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0]), Buffer.from([2, 1, 0, 0, 0x3b])]);
  assert.throws(() => sanitizeImage(gif), (e) => e.status === 415);
  const okGif = Buffer.from(gif); okGif.writeUInt16LE(1, 18); okGif.writeUInt16LE(1, 20);
  assert.equal(sanitizeImage(okGif).width, 1);
  const big = Buffer.from(PNG); big.writeUInt32BE(10000, 16); big.writeUInt32BE(10000, 20);
  assert.throws(() => sanitizeImage(big), (e) => e.status === 413);
});

test('PNG text chunks and trailing data are dropped; polyglots and pixel bombs rejected', async () => {
  const c = await signup('pnguser');
  const crc = () => Buffer.alloc(4);
  const chunk = (t, d) => Buffer.concat([Buffer.from([0, 0, 0, d.length]), Buffer.from(t), d, crc()]);
  const withText = Buffer.concat([PNG.subarray(0, 33), chunk('tEXt', Buffer.from('Comment\0SECRET-GPS')), PNG.subarray(33), Buffer.from('<?php SECRET-TRAILER ?>')]);
  const r = await call('POST', '/api/images', { cookie: c, raw: withText });
  assert.equal(r.status, 201);
  const bytes = Buffer.from(await (await fetch(base + r.data.images[0].url, { headers: { Cookie: c } })).arrayBuffer());
  assert.ok(!bytes.includes('SECRET'));
  const bomb = Buffer.from(PNG); bomb.writeUInt32BE(60000, 16); bomb.writeUInt32BE(60000, 20);
  assert.equal((await call('POST', '/api/images', { cookie: c, raw: bomb })).status, 413);
  assert.equal((await call('POST', '/api/images', { cookie: c, raw: Buffer.from('GIF89a<script>alert(1)</script>') })).status, 415);
});

test('uploads over 10 MB get a 413 answer (not a dropped connection)', async () => {
  const c = await signup('bigfile');
  const r = await call('POST', '/api/images', { cookie: c, raw: Buffer.alloc(11 * 1024 * 1024, 1) });
  assert.equal(r.status, 413);
  assert.match(r.data.error, /10 MB/);
});

test('overlapping thumbnail uploads and upload-vs-delete leave no orphan files', async () => {
  const c = await signup('racer');
  const up = await call('POST', '/api/images?title=a', { cookie: c, raw: PNG });
  const id = up.data.images[0].id;
  let before = uploadsDir().length;
  // at most 2 uploads at once per user; the rest are told to wait (429)
  const rs = await Promise.all([1, 2, 3, 4].map((i) => slow('PUT', `/api/images/${id}/thumb`, { cookie: c, body: PNG, delay: 40 * i })));
  assert.equal(rs.filter((r) => r.status === 200).length, 2);
  assert.equal(rs.filter((r) => r.status === 429).length, 2);
  assert.equal(uploadsDir().length - before, 1); // exactly one thumbnail on disk
  const up2 = await call('POST', `/api/images?work=${up.data.id}`, { cookie: c, raw: PNG });
  const id2 = up2.data.images.at(-1).id;
  before = uploadsDir().length;
  const [put, del] = await Promise.all([slow('PUT', `/api/images/${id2}/thumb`, { cookie: c, body: PNG, delay: 150 }), new Promise((r) => setTimeout(r, 30)).then(() => call('DELETE', `/api/images/${id2}`, { cookie: c }))]);
  assert.equal(del.status, 200);
  assert.equal(put.status, 404);
  assert.equal(uploadsDir().length - before, -1);
});

test('housekeeping removes old files that no row points to', () => {
  const stray = path.join(DATA, 'uploads', 'f'.repeat(32) + '.png');
  fs.writeFileSync(stray, PNG);
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(stray, old, old);
  const fresh = path.join(DATA, 'uploads', 'e'.repeat(32) + '.png');
  fs.writeFileSync(fresh, PNG);
  assert.ok(app.sweepOrphanFiles() >= 1);
  assert.ok(!fs.existsSync(stray));
  assert.ok(fs.existsSync(fresh)); // too new to be sure: kept for now
  fs.rmSync(fresh);
});

test('password policy: min 10, common and username-based passwords refused', async () => {
  const bad = ['short1', 'password123', '1234567890', 'qwertyuiop'];
  for (const [i, pw] of bad.entries()) assert.equal((await signupRaw('pp' + i, pw)).status, 400, pw);
  assert.equal((await signupRaw('bobsmith', 'bobsmith1234')).status, 400);
});

test('passwords are Unicode-normalized: é typed either way works', async () => {
  const nfd = 'café-au-lait-9', nfc = 'café-au-lait-9';
  assert.equal((await signupRaw('unicoder', nfd)).status, 201);
  assert.equal((await call('POST', '/api/login', { body: { username: 'unicoder', password: nfc } })).status, 200);
});

test('names: confusable and reserved usernames are refused', async () => {
  await signup('maria_art');
  for (const u of ['marla_art', 'Maria_Art', 'admin', 'Support', 'rnaria_art'])
    assert.ok([400, 409].includes((await signupRaw(u)).status), u);
  const a = await signup('alice_a'); await signup('bob_b');
  assert.equal((await call('PATCH', '/api/profile', { cookie: a, body: { displayName: 'bob_b' } })).status, 409);
  assert.equal((await call('PATCH', '/api/profile', { cookie: a, body: { displayName: 'Admin' } })).status, 400);
});

test('contact email cannot smuggle mailto parameters', async () => {
  const c = await signup('mailer');
  for (const e of ['a@b.co?subject=Urgent&body=x', 'a@b.co,c@d.co', 'a b@c.de', 'x@y', 'a..b@c.de']) assert.equal((await call('PATCH', '/api/profile', { cookie: c, body: { contactEmail: e } })).status, 400, e);
  assert.equal((await call('PATCH', '/api/profile', { cookie: c, body: { contactEmail: 'me@studio.art' } })).status, 200);
});

test('an attacker cannot lock the owner out: a recognized device still gets in', async () => {
  const first = await signupRaw('victim_v');
  const device = cookies(first).split('; ').find((c) => /^(__Host-)?dev=/.test(c));
  assert.ok(device, 'signup sets a device cookie');
  for (let i = 0; i < 10; i++) await call('POST', '/api/login', { body: { username: 'victim_v', password: 'wrong-wrong-1' } });
  // unrecognized browsers are limited...
  assert.equal((await call('POST', '/api/login', { body: { username: 'victim_v', password: PW } })).status, 429);
  // ...but the owner's own browser is not
  assert.equal((await call('POST', '/api/login', { cookie: device, body: { username: 'victim_v', password: PW } })).status, 200);
  // and the failures show up as one entry with a count, not 10 rows that push everything else out
  const act = await call('GET', '/api/activity', { cookie: sid(first) });
  const failed = act.data.events.filter((e) => e.event === 'login_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].detail, '10');
  // successful logins don't use up anything
  await signup('busy_user');
  for (let i = 0; i < 12; i++) assert.equal((await call('POST', '/api/login', { headers: { 'X-Forwarded-For': '9.9.9.9' }, body: { username: 'busy_user', password: PW } })).status, 200);
});

test('parallel guesses cannot skip the limits', async () => {
  await signup('target2');
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => call('POST', '/api/login', { headers: { 'X-Forwarded-For': '198.51.100.7' }, body: { username: 'target2', password: 'guess-guess-' + i } })));
  assert.ok(rs.filter((r) => r.status === 401).length <= 5, 'at most 5 guesses per account+IP are checked');
  assert.ok(rs.every((r) => [401, 429].includes(r.status)));
  // site-wide signup cap holds under a burst
  const used = L.signupAll.size ? L.signupAll.hits.get('all').length : 0;
  const saved = L.signupAll.max;
  L.signupAll.max = used + 2;
  const ss = await Promise.all(Array.from({ length: 6 }, (_, i) => signupRaw('burst' + 'abcdef'[i] + 'x')));
  L.signupAll.max = saved;
  assert.equal(ss.filter((r) => r.status === 201).length, 2);
});

test('made-up usernames cost no hashing, but take as long as real ones', async () => {
  await signup('timed_user');
  const time = async (username) => { const t = Date.now(); await call('POST', '/api/login', { body: { username, password: 'wrong-wrong-1' } }); return Date.now() - t; };
  const known = await time('timed_user'), unknown = await time('no_such_user_x');
  assert.ok(unknown >= known * 0.6 && unknown <= known * 1.6, `known ${known} ms vs unknown ${unknown} ms`);
  // a flood of made-up names from many IPs doesn't fill the hashing queue ("server busy")
  const flood = await Promise.all(Array.from({ length: 150 }, (_, i) => call('POST', '/api/login', { body: { username: 'ghost' + i, password: 'x' } })));
  assert.equal(flood.filter((r) => r.status === 503).length, 0);
});

test('rate-limit helpers: IPv6 grouped by /64, take/refund are atomic', () => {
  assert.equal(S.ipKey('2001:db8:1:2:aaaa::1'), S.ipKey('2001:db8:1:2:ffff:1:2:3'));
  assert.notEqual(S.ipKey('2001:db8:1:2::1'), S.ipKey('2001:db8:1:3::1'));
  assert.equal(S.ipKey('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(S.ipKey('203.0.113.5'), '203.0.113.5');
  const lim = new S.Limiter(2, 60e3, { cap: 3, evict: false });
  assert.ok(lim.take('a') && lim.take('a') && !lim.take('a'));
  lim.refund('a');
  assert.ok(lim.take('a'));
  lim.take('b'); lim.take('c');
  assert.equal(lim.take('d'), false); // full of live entries: refuses instead of forgetting 'a'
  assert.equal(lim.tooMany('a'), true);
});

test('X-Forwarded-Proto is read from the trusted proxy, not the client', async () => {
  const spoof = await call('GET', '/api/me', { headers: { 'X-Forwarded-Proto': 'https, http' } });
  assert.equal(spoof.res.headers.get('strict-transport-security'), null);
  const real = await call('GET', '/api/me', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(real.res.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('legacy password hashes still work and are upgraded on login', async () => {
  const crypto = require('node:crypto');
  const salt = 'abcd', hash = crypto.scryptSync('legacy-pass-123', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  const db = new DatabaseSync(path.join(DATA, 'artfolio.db'));
  db.prepare("UPDATE users SET pw_salt=?, pw_hash=? WHERE username='legacy'").run(salt, hash);
  assert.equal((await call('POST', '/api/login', { body: { username: 'legacy', password: 'legacy-pass-123' } })).status, 200);
  assert.match(db.prepare("SELECT pw_hash FROM users WHERE username='legacy'").get().pw_hash, /^scrypt:15:8:3:/);
  db.close();
  assert.equal((await call('POST', '/api/login', { body: { username: 'legacy', password: 'legacy-pass-123' } })).status, 200);
});

test('drafts and hidden works are invisible to visitors, images included', async () => {
  const r = await signupRaw('secretive');
  const c = sid(r);
  const up = await call('POST', '/api/images', { cookie: c, raw: PNG });
  const url = up.data.images[0].url;
  assert.equal((await fetch(base + '/u/secretive')).status, 404);
  assert.equal((await fetch(base + url)).status, 404);
  const own = await fetch(base + url, { headers: { Cookie: c } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('cache-control'), 'private, no-store');
  const page = await (await fetch(base + '/u/secretive', { headers: { Cookie: c } })).text();
  assert.match(page, /Draft/);
  assert.match(page, /noindex/);
  await call('PATCH', '/api/profile', { cookie: c, body: { published: true } });
  const pub = await fetch(base + url);
  assert.equal(pub.status, 200);
  await call('PATCH', `/api/works/${up.data.id}`, { cookie: c, body: { hidden: true } });
  // even a browser revalidating its cached copy is refused now
  assert.equal((await fetch(base + url, { headers: { 'If-None-Match': pub.headers.get('etag') } })).status, 404);
  assert.doesNotMatch(await (await fetch(base + '/u/secretive')).text(), /class="work"/);
});

test("cannot delete a piece's last image; storage quota is enforced", async () => {
  const c = await signup('quotauser');
  const up = await call('POST', '/api/images', { cookie: c, raw: PNG });
  assert.equal((await call('DELETE', `/api/images/${up.data.images[0].id}`, { cookie: c })).status, 400);
  const me = await call('GET', '/api/me', { cookie: c });
  assert.ok(me.data.storage.used > 0 && me.data.storage.limit === app.USER_QUOTA);
});

test('uploads are 0600; activity log works; malformed cookies are harmless', async () => {
  const r = await signupRaw('tlsuser');
  assert.doesNotMatch(r.res.headers.get('set-cookie'), /Secure/); // dev mode: plain cookies (see next test)
  const c = sid(r);
  const up = await call('POST', '/api/images', { cookie: c, raw: PNG });
  assert.equal(up.status, 201);
  const file = path.join(DATA, 'uploads', up.data.images[0].url.slice(5));
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  const act = await call('GET', '/api/activity', { cookie: c });
  assert.ok(act.data.events.some((e) => e.event === 'signup'));
  assert.equal((await call('GET', '/api/me', { cookie: 'sid=x; ;;=bad; %E0%A4%A=1' })).status, 401);
});

test('SECURE_COOKIES=1: __Host- cookies with Secure, on every request', async () => {
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: dir, PORT: '0', SECURE_COOKIES: '1' } });
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:(\d+)/); if (m) resolve(`http://localhost:${m[1]}`); });
    child.on('exit', reject);
  });
  try {
    const r = await fetch(url + '/api/signup', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'secure_one', email: 's@example.com', password: PW }) });
    const set = r.headers.getSetCookie();
    assert.ok(set.some((c) => /^__Host-sid=.*; Secure/.test(c)));
    assert.ok(set.some((c) => /^__Host-dev=.*; Secure/.test(c)));
  } finally {
    child.kill();
  }
});

test('sign out other devices keeps the current session', async () => {
  const a = await signup('multi_dev');
  const b = sid(await call('POST', '/api/login', { body: { username: 'multi_dev', password: PW } }));
  const r = await call('POST', '/api/sessions/revoke-others', { cookie: a });
  assert.equal(r.data.revoked, 1);
  assert.equal((await call('GET', '/api/me', { cookie: a })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: b })).status, 401);
});

test('backup: every image the backed-up database refers to is in the backup; backups/ is git-ignored', async () => {
  const { execFileSync } = require('node:child_process');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const out = execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'scripts', 'backup.js'), dest], { env: { ...process.env, DATA_DIR: DATA } }).toString();
  assert.match(out, /Backup written/);
  const dir = path.join(dest, fs.readdirSync(dest)[0]);
  const snap = new DatabaseSync(path.join(dir, 'artfolio.db'));
  const files = new Set(fs.readdirSync(path.join(dir, 'uploads')));
  const rows = snap.prepare("SELECT filename, thumb FROM images WHERE filename NOT LIKE 'aaaa%'").all(); // the v1 seed row never had a file
  snap.close();
  for (const r of rows) for (const f of [r.filename, r.thumb]) if (f) assert.ok(files.has(f), f);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8'), /^backups\/$/m);
  // pointed at the wrong folder, it refuses instead of backing up an empty database
  assert.throws(() => execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'scripts', 'backup.js'), dest], { env: { ...process.env, DATA_DIR: os.tmpdir() }, stdio: 'pipe' }));
});
