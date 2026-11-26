'use strict';
// Artfolio: a zero-dependency portfolio builder for artists.
// Requires Node 22.5+ (built-in node:sqlite, which Node still labels experimental).
process.umask(0o077); // everything we create (database, uploads, outbox) is private to the server's user

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('Artfolio needs Node 22.5 or newer (for the built-in node:sqlite module).');
  process.exit(1);
}
const { HttpError } = require('./lib/errors');
const { sanitizeImage } = require('./lib/imagesafe');
const { createMailer } = require('./lib/mailer');
const S = require('./lib/security');

// ---------- configuration ----------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRODUCTION = process.env.NODE_ENV === 'production';
// Cookie security is a setting, not a per-request guess, so the cookie name never changes between requests.
const SECURE_COOKIES = PRODUCTION || process.env.SECURE_COOKIES === '1';
const SESSION_COOKIE = SECURE_COOKIES ? '__Host-sid' : 'sid';
const DEVICE_COOKIE = SECURE_COOKIES ? '__Host-dev' : 'dev';
const HSTS = 'max-age=31536000' + (process.env.HSTS_INCLUDE_SUBDOMAINS === '1' ? '; includeSubDomains' : '');
let PUBLIC_ORIGIN;
try {
  PUBLIC_ORIGIN = new URL(process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`).origin; // used in emails and share previews
} catch {
  console.error('PUBLIC_ORIGIN must be a URL like https://artfolio.example.com');
  process.exit(1);
}
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB per uploaded file
const MAX_JSON = 64 * 1024;
const MAX_PARALLEL_UPLOADS = Number(process.env.MAX_PARALLEL_UPLOADS) || 24; // whole server (each holds up to 10 MB in memory)
const SESSION_DAYS = 30;
const DEVICE_DAYS = 365;
const USER_QUOTA = (Number(process.env.USER_QUOTA_MB) || 500) * 1024 * 1024;
const MAX_SIGNUPS_PER_HOUR = Number(process.env.MAX_SIGNUPS_PER_HOUR) || 100;
const AUTH_MIN_MS = process.env.AUTH_MIN_MS !== undefined ? Number(process.env.AUTH_MIN_MS) : 400; // minimum response time for login and reset requests
const CODE_TTL = { verify: 24 * 3600e3, reset: 20 * 60e3 };
const CODE_MAX_TRIES = 5;
const TEMPLATES = ['gallery', 'grid', 'editorial', 'studio', 'carousel', 'spotlight'];
const THEMES = ['chalk', 'ink', 'sage', 'midnight'];
const LIMITS = { works: 200, imagesPerWork: 12, collections: 20 };

if (PRODUCTION && !process.env.SMTP_URL && process.env.MAIL_TRANSPORT !== 'log') {
  console.error('Set SMTP_URL so password-reset emails can be sent (or MAIL_TRANSPORT=log to deliberately run without email).');
  process.exit(1);
}
const mail = createMailer({
  url: process.env.SMTP_URL,
  from: process.env.MAIL_FROM || `Artfolio <no-reply@${new URL(PUBLIC_ORIGIN).hostname}>`,
  outbox: path.join(DATA_DIR, 'outbox'),
});

// ---------- database ----------
const dataDirExisted = fs.existsSync(DATA_DIR);
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
if (!dataDirExisted) fs.chmodSync(DATA_DIR, 0o700); // never change permissions on a directory the operator pointed us at
fs.chmodSync(UPLOAD_DIR, 0o700);
const DB_FILE = path.join(DATA_DIR, 'artfolio.db');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);

const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

// ---------- schema + migrations ----------
// The whole migration runs in ONE transaction: if any step fails, nothing changes and the next start
// retries from a clean state (no half-migrated database, no duplicated rows).
const SCHEMA_VERSION = 3;
const startVersion = db.prepare('PRAGMA user_version').get().user_version;
const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const addCol = (table, col, def) => !hasCol(table, col) && (db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`), true);
try {
  tx(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL DEFAULT '',
        bio TEXT NOT NULL DEFAULT '',
        theme TEXT NOT NULL DEFAULT 'chalk',
        pw_salt TEXT NOT NULL,
        pw_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS works (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY,
        work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        thumb TEXT,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS email_codes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS works_user ON works(user_id, position);
      CREATE INDEX IF NOT EXISTS images_work ON images(work_id, position);
      CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, id);
      CREATE INDEX IF NOT EXISTS codes_user ON email_codes(user_id, purpose);
    `);
    addCol('users', 'template', "TEXT NOT NULL DEFAULT 'gallery'");
    addCol('users', 'contact_email', "TEXT NOT NULL DEFAULT ''");
    addCol('users', 'website', "TEXT NOT NULL DEFAULT ''");
    addCol('users', 'instagram', "TEXT NOT NULL DEFAULT ''");
    addCol('users', 'username_key', "TEXT NOT NULL DEFAULT ''");
    addCol('users', 'display_key', "TEXT NOT NULL DEFAULT ''");
    addCol('users', 'recovery_hash', "TEXT NOT NULL DEFAULT ''"); // no longer used (recovery keys were replaced by email)
    addCol('users', 'email', "TEXT NOT NULL DEFAULT ''"); // verified sign-in email (private), lowercase
    addCol('users', 'pending_email', "TEXT NOT NULL DEFAULT ''"); // waiting for its confirmation code
    if (addCol('users', 'published', 'INTEGER NOT NULL DEFAULT 0')) db.exec('UPDATE users SET published = 1'); // existing sites stay live
    addCol('works', 'collection_id', 'INTEGER REFERENCES collections(id) ON DELETE SET NULL');
    addCol('works', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
    addCol('images', 'bytes', 'INTEGER NOT NULL DEFAULT 0');
    addCol('images', 'thumb_bytes', 'INTEGER NOT NULL DEFAULT 0');
    if (hasCol('works', 'filename')) {
      // v1 -> v2: each work had one image inline; move it into the images table.
      db.exec('INSERT INTO images (work_id, filename, position) SELECT id, filename, 0 FROM works');
      db.exec('ALTER TABLE works DROP COLUMN filename');
    }
    // palettes were renamed (minimal/dark/warm/bold -> chalk/ink/sage/midnight)
    db.exec(`UPDATE users SET theme = CASE theme WHEN 'minimal' THEN 'chalk' WHEN 'dark' THEN 'ink' WHEN 'warm' THEN 'sage' WHEN 'bold' THEN 'midnight' ELSE theme END
             WHERE theme IN ('minimal','dark','warm','bold')`);
    if (startVersion < SCHEMA_VERSION) {
      // one-time backfills for rows made by older versions: name keys (confusable-safe uniqueness) and stored sizes (quota)
      for (const u of db.prepare("SELECT id, username, display_name FROM users WHERE username_key = ''").all()) {
        db.prepare('UPDATE users SET username_key = ?, display_key = ? WHERE id = ?').run(
          S.skeleton(u.username), u.display_name && u.display_name !== u.username ? S.skeleton(u.display_name) : '', u.id
        );
      }
      for (const i of db.prepare('SELECT id, filename, thumb FROM images WHERE bytes = 0').all()) {
        const size = (f) => { try { return fs.statSync(path.join(UPLOAD_DIR, f)).size; } catch { return 0; } };
        db.prepare('UPDATE images SET bytes = ?, thumb_bytes = ? WHERE id = ?').run(size(i.filename), i.thumb ? size(i.thumb) : 0, i.id);
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS images_file ON images(filename);
      CREATE INDEX IF NOT EXISTS images_thumb ON images(thumb);
      CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email) WHERE email != '';
    `);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
} catch (e) {
  console.error('Database migration failed; nothing was changed. Fix the problem below and start again.\n', e);
  process.exit(1);
}
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_key ON users(username_key)');
} catch {
  const dups = db.prepare("SELECT username_key k, group_concat(username, ', ') names FROM users GROUP BY username_key HAVING COUNT(*) > 1").all();
  console.error(
    '\n*** WARNING: these existing accounts have usernames that look alike, so the database cannot enforce unique names:\n' +
      dups.map((d) => `    ${d.names}`).join('\n') +
      '\n*** New signups are still checked in code. Rename one account in each group, then restart to add the safeguard.\n'
  );
}

// ---------- helpers ----------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Run fn, but never answer faster than `ms`: hides whether an account exists or which kind of hash it has.
async function atLeast(ms, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const left = ms - (Date.now() - start);
    if (left > 0) await sleep(left);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";

// Is this request arriving over HTTPS (directly, or via a proxy we are told to trust)?
const isSecure = (req) => !!req.socket.encrypted || S.forwardedProto(req) === 'https';

function send(req, res, status, body, headers = {}) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': CSP,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...headers,
  };
  if (req && isSecure(req)) h['Strict-Transport-Security'] = HSTS;
  res.writeHead(status, h);
  res.end(body);
}
const json = (req, res, status, obj, headers = {}) =>
  send(req, res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

// Read a request body up to `limit` bytes. Too-large bodies get a proper 413 answer instead of a
// dropped connection: a declared size is refused up front, and an undeclared one is drained (not stored).
function readBody(req, limit, tooBig = 'That request is too large') {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      req.resume(); // discard what the client is still sending, so it can read our answer
      return reject(new HttpError(413, tooBig));
    }
    const chunks = [];
    let size = 0, over = false;
    req.on('data', (c) => {
      size += c.length;
      if (over) {
        if (size > limit * 4) req.destroy(); // not going to drain forever
        return;
      }
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(new HttpError(413, tooBig)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const cleanText = S.cleanText;
function cleanUrl(v) {
  const t = cleanText(v, 200, 'Website');
  if (!t) return '';
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t);
  } catch {
    throw new HttpError(400, 'That website address does not look right');
  }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.') || u.username || u.password)
    throw new HttpError(400, 'That website address does not look right');
  return u.href;
}
function cleanEmail(v, field = 'Email') {
  const t = cleanText(v, 120, field);
  if (t && !S.validEmail(t)) throw new HttpError(400, 'That email address does not look right');
  return t;
}
const cleanAccountEmail = (v) => cleanEmail(v ?? '').toLowerCase();
function cleanInstagram(v) {
  const t = cleanText(v, 40, 'Instagram').replace(/^@/, '');
  if (t && !/^[A-Za-z0-9._]{1,30}$/.test(t)) throw new HttpError(400, 'Instagram handle can only use letters, numbers, . and _');
  return t;
}

// ---------- rate limits ----------
// Every limit is taken BEFORE any slow work (S.takeAll), so parallel requests can't slip past it.
// Successful attempts are refunded: people are never limited by their own successes.
const MIN = 60e3, HOUR = 60 * MIN;
const L = {
  loginIp: new S.Limiter(30, 15 * MIN), // failed logins per IP (IPv6: per /64)
  loginAcct: new S.Limiter(10, 15 * MIN, { evict: false }), // failed logins per account from unrecognized devices
  loginUnknown: new S.Limiter(10, 15 * MIN), // same, for names that aren't accounts (so the 429 doesn't reveal which exist)
  loginPair: new S.Limiter(5, 15 * MIN, { evict: false }), // failed logins per account + IP (or + recognized device)
  signupIp: new S.Limiter(8, HOUR), // signup attempts per IP
  signupAll: new S.Limiter(MAX_SIGNUPS_PER_HOUR, HOUR), // new accounts per hour, whole site
  resetReqIp: new S.Limiter(10, HOUR), // "email me a code" requests per IP
  resetReqAcct: new S.Limiter(5, HOUR, { evict: false }), // reset emails per account (limits mail bombing)
  resetTryIp: new S.Limiter(20, HOUR), // wrong reset codes per IP
  verifySend: new S.Limiter(5, HOUR, { evict: false }), // confirmation emails per account
  verifyTry: new S.Limiter(20, HOUR, { evict: false }), // wrong confirmation codes per account
  sensitive: new S.Limiter(8, 15 * MIN, { evict: false }), // wrong current-password attempts (password/email change, deletion), per user
};
const limiters = Object.values(L);

function audit(userId, event, req, detail = '') {
  const ip = req ? S.clientIp(req) : '';
  if (event === 'login_failed') {
    // a burst of failures becomes one entry with a count, so it can't push real events out of the activity list
    const last = db.prepare('SELECT id, event, ts, detail FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
    if (last && last.event === 'login_failed' && Date.now() - last.ts < HOUR) {
      db.prepare('UPDATE audit SET ts = ?, ip = ?, detail = ? WHERE id = ?').run(Date.now(), ip, String((Number(last.detail) || 1) + 1), last.id);
      return;
    }
    detail = '1';
  }
  db.prepare('INSERT INTO audit (user_id, ts, event, ip, detail) VALUES (?,?,?,?,?)').run(userId, Date.now(), event, ip, detail);
}

// ---------- sessions and recognized devices ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie values instead of crashing */
    }
  }
  return out;
}
const cookie = (name, value, maxAgeSec) =>
  `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${SECURE_COOKIES ? '; Secure' : ''}`;
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, Date.now() + SESSION_DAYS * 86400e3);
  return cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400);
}
const clearSession = () => cookie(SESSION_COOKIE, '', 0);
function getUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    return null;
  }
  return row;
}
// A browser that has signed in to an account before gets a long-lived "device" cookie. Logins from a
// recognized device skip the per-account failure limit, so an attacker hammering an account from
// elsewhere can't lock its owner out (OWASP "device cookie" pattern).
function recognizedDevice(req, userId) {
  const t = parseCookies(req)[DEVICE_COOKIE];
  if (!t) return null;
  const row = db.prepare('SELECT token_hash FROM devices WHERE token_hash = ? AND user_id = ? AND expires_at > ?').get(sha(t), userId, Date.now());
  return row ? row.token_hash : null;
}
function rememberDevice(req, userId) {
  const known = recognizedDevice(req, userId);
  if (known) {
    db.prepare('UPDATE devices SET expires_at = ? WHERE token_hash = ?').run(Date.now() + DEVICE_DAYS * 86400e3, known);
    return null;
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO devices (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, Date.now() + DEVICE_DAYS * 86400e3);
  return cookie(DEVICE_COOKIE, token, DEVICE_DAYS * 86400);
}
// Sign in: new session (+ device cookie). Returns the Set-Cookie list.
const signIn = (req, userId) => [createSession(userId), rememberDevice(req, userId)].filter(Boolean);

// ---------- email codes ----------
function issueCode(userId, purpose, email) {
  const code = S.newCode();
  if (purpose === 'verify') db.prepare("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'verify'").run(userId);
  // Reset codes don't cancel each other (so someone else asking for codes can't keep invalidating yours); at most 3 live.
  else db.prepare(
    "DELETE FROM email_codes WHERE user_id = ? AND purpose = ? AND id NOT IN (SELECT id FROM email_codes WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 2)"
  ).run(userId, purpose, userId, purpose);
  const now = Date.now();
  db.prepare('INSERT INTO email_codes (user_id, purpose, email, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)').run(
    userId, purpose, email, S.hashCode(purpose, userId, code), now + CODE_TTL[purpose], now
  );
  return code;
}
// Returns the matching code row (and deletes it: codes work once), or null after counting a wrong try.
function useCode(userId, purpose, given) {
  const rows = db.prepare('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ? AND expires_at > ? AND attempts < ?').all(userId, purpose, Date.now(), CODE_MAX_TRIES);
  const h = S.hashCode(purpose, userId, given);
  const hit = rows.find((r) => S.hashesEqual(r.code_hash, h));
  if (!hit) {
    for (const r of rows) db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(r.id);
    return null;
  }
  db.prepare('DELETE FROM email_codes WHERE id = ?').run(hit.id);
  return hit;
}

const SIGNOFF = '\n\n— Artfolio\n';
const emails = {
  verify: (code, user) => [
    'Confirm your email for Artfolio',
    `Hi ${user.username},\n\nYour confirmation code is:\n\n    ${code}\n\nEnter it in your Artfolio dashboard, or open this link while signed in:\n${PUBLIC_ORIGIN}/#verify=${encodeURIComponent(code)}\n\nThe code works for 24 hours. If you didn't sign up or change your email on Artfolio, you can ignore this message.` + SIGNOFF,
  ],
  reset: (code, user, email) => [
    'Your Artfolio password reset code',
    `Hi ${user.username},\n\nSomeone (hopefully you) asked to reset the password for your Artfolio account.\n\nYour code is:\n\n    ${code}\n\nOr open this link to choose a new password:\n${PUBLIC_ORIGIN}/#reset?email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}\n\nThe code works once, for 20 minutes. If you didn't ask for this, ignore this email: your password stays the same.` + SIGNOFF,
  ],
  passwordChanged: (user) => [
    'Your Artfolio password was changed',
    `Hi ${user.username},\n\nThe password for your Artfolio account was just changed, and other devices were signed out.\n\nIf this wasn't you, reset your password right away at ${PUBLIC_ORIGIN}/ ("Forgot your password?").` + SIGNOFF,
  ],
  emailChanging: (user, next) => [
    'Your Artfolio email is being changed',
    `Hi ${user.username},\n\nSomeone signed in to your Artfolio account asked to change its email to ${next}. The change happens once that address is confirmed.\n\nIf this wasn't you, sign in and change your password now.` + SIGNOFF,
  ],
};
const sendMail = (to, [subject, text]) => mail.send(to, subject, text);

// ---------- data access ----------
const selfUser = (u) => ({
  username: u.username,
  displayName: u.display_name || u.username,
  bio: u.bio,
  template: u.template,
  theme: u.theme,
  contactEmail: u.contact_email,
  website: u.website,
  instagram: u.instagram,
  published: !!u.published,
  email: u.email,
  pendingEmail: u.pending_email,
});

function loadPortfolio(userId, { includeHidden }) {
  const collections = db.prepare('SELECT id, name FROM collections WHERE user_id = ? ORDER BY position, id').all(userId);
  const works = db.prepare(`SELECT * FROM works WHERE user_id = ? ${includeHidden ? '' : 'AND hidden = 0'} ORDER BY position, id`).all(userId);
  const images = db
    .prepare('SELECT i.* FROM images i JOIN works w ON w.id = i.work_id WHERE w.user_id = ? ORDER BY i.position, i.id')
    .all(userId);
  const byWork = new Map(works.map((w) => [w.id, { ...w, images: [] }]));
  for (const im of images) byWork.get(im.work_id)?.images.push(im);
  return { collections, works: works.map((w) => byWork.get(w.id)) };
}
const apiWork = (w) => ({
  id: w.id,
  title: w.title,
  description: w.description,
  collectionId: w.collection_id,
  hidden: !!w.hidden,
  images: w.images.map((i) => ({ id: i.id, url: `/img/${i.filename}`, thumb: `/img/${i.thumb || i.filename}` })),
});
const usage = (userId) =>
  db.prepare('SELECT COALESCE(SUM(i.bytes + i.thumb_bytes),0) n FROM images i JOIN works w ON w.id = i.work_id WHERE w.user_id = ?').get(userId).n;

function removeFiles(rows) {
  for (const r of rows) for (const f of [r.filename, r.thumb]) if (f) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
}
// Validate, clean (strip metadata), check quota, and store an uploaded image. Returns { filename, bytes }.
// Synchronous on purpose: callers record the file in the database in the same tick, so nothing can interleave.
function storeImage(buf, userId, extraBytes = 0) {
  const clean = sanitizeImage(buf);
  if (usage(userId) + clean.buf.length - extraBytes > USER_QUOTA)
    throw new HttpError(413, `You've used your ${Math.round(USER_QUOTA / 1048576)} MB of storage. Delete something or ask for more space.`);
  const filename = crypto.randomBytes(16).toString('hex') + clean.ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), clean.buf, { mode: 0o600 });
  return { filename, bytes: clean.buf.length };
}
// Uploads are buffered in memory, so limit how many run at once (per user, and for the whole server).
const uploading = new Map();
let uploadingAll = 0;
function uploadSlot(userId) {
  const n = uploading.get(userId) || 0;
  if (n >= 2 || uploadingAll >= MAX_PARALLEL_UPLOADS) throw new HttpError(429, 'Too many uploads at once. Please wait a moment and try again.');
  uploading.set(userId, n + 1);
  uploadingAll++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    uploadingAll--;
    const k = uploading.get(userId) - 1;
    if (k > 0) uploading.set(userId, k);
    else uploading.delete(userId);
  };
}

// Names: usernames and display names must not collide with, or imitate, anyone else's (or a reserved word).
function checkUsernameFree(username) {
  const key = S.skeleton(username);
  if (!key || S.RESERVED_KEYS.has(key)) throw new HttpError(400, 'That username is reserved');
  if (db.prepare('SELECT 1 FROM users WHERE username = ? OR username_key = ? OR display_key = ?').get(username, key, key))
    throw new HttpError(409, db.prepare('SELECT 1 FROM users WHERE username = ?').get(username) ? 'That username is taken' : 'That username is too similar to an existing name');
  return key;
}
function checkDisplayName(name, user) {
  if (!name) return '';
  if (!S.hasVisible(name)) throw new HttpError(400, 'Your name needs at least one visible letter, number or symbol');
  if (S.mixesScripts(name)) throw new HttpError(400, 'Please do not mix Latin letters with Cyrillic or Greek ones in a name');
  const key = S.skeleton(name);
  if (!key) return ''; // e.g. emoji-only: nothing to compare
  if (key === S.skeleton(user.username)) return key;
  if (S.RESERVED_KEYS.has(key)) throw new HttpError(400, 'That name is reserved');
  if (db.prepare('SELECT 1 FROM users WHERE id != ? AND (username_key = ? OR display_key = ?)').get(user.id, key, key))
    throw new HttpError(409, 'Another artist already uses that name or one very close to it');
  return key;
}

// ---------- public portfolio page ----------
function renderPortfolio(user, collections, works, { draft = false } = {}) {
  const rawName = user.display_name || user.username;
  const name = esc(rawName);
  const template = TEMPLATES.includes(user.template) ? user.template : 'gallery';
  const theme = THEMES.includes(user.theme) ? user.theme : 'chalk';
  const shown = works.filter((w) => w.images.length);
  const usedCollections = collections.filter((c) => shown.some((w) => w.collection_id === c.id));
  const pageUrl = `${PUBLIC_ORIGIN}/u/${encodeURIComponent(user.username)}`;
  const cover = shown[0]?.images[0];

  const links = [
    user.website && `<a href="${esc(user.website)}" target="_blank" rel="noopener noreferrer">Website</a>`,
    user.instagram && `<a href="https://instagram.com/${esc(user.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a>`,
    user.contact_email && S.validEmail(user.contact_email) && `<a href="mailto:${esc(user.contact_email)}">Contact</a>`,
  ].filter(Boolean);

  const filters = usedCollections.length
    ? `<nav class="filters" aria-label="Collections"><button type="button" data-filter="" aria-pressed="true">All</button>${usedCollections
        .map((c) => `<button type="button" data-filter="${c.id}" aria-pressed="false">${esc(c.name)}</button>`)
        .join('')}</nav>`
    : '';

  const items = shown
    .map((w) => {
      const [first, ...rest] = w.images;
      const alt = esc(w.title || 'Artwork by ' + rawName);
      // Always ship the small image; portfolio.js upgrades to data-full for big layouts, so layouts can switch live.
      const coverSrc = first.thumb || first.filename;
      const extra = rest.map((i) => `<a class="lb" hidden href="/img/${esc(i.filename)}" data-w="${w.id}"></a>`).join('');
      const badge = rest.length ? `<span class="count"><span aria-hidden="true">+${rest.length}</span><span class="sr">${w.images.length} images</span></span>` : '';
      const cap =
        w.title || w.description
          ? `<figcaption>${w.title ? `<h2>${esc(w.title)}</h2>` : ''}${w.description ? `<p>${esc(w.description).replace(/\n/g, '<br>')}</p>` : ''}</figcaption>`
          : '';
      return `<figure class="work" data-collection="${w.collection_id ?? ''}">
        <a class="lb cover" href="/img/${esc(first.filename)}" data-w="${w.id}"><img loading="lazy" src="/img/${esc(coverSrc)}" data-full="/img/${esc(first.filename)}" alt="${alt}">${badge}</a>${extra}${cap}
      </figure>`;
    })
    .join('');

  const description = esc([...(user.bio || `Portfolio of ${rawName}`)].slice(0, 160).join('').replace(/\s+/g, ' '));
  const social = draft
    ? '<meta name="robots" content="noindex">'
    : [
        `<link rel="canonical" href="${esc(pageUrl)}">`,
        '<meta property="og:type" content="website">',
        `<meta property="og:title" content="${name}">`,
        `<meta property="og:description" content="${description}">`,
        `<meta property="og:url" content="${esc(pageUrl)}">`,
        cover && `<meta property="og:image" content="${esc(`${PUBLIC_ORIGIN}/img/${cover.thumb || cover.filename}`)}">`,
        `<meta name="twitter:card" content="${cover ? 'summary_large_image' : 'summary'}">`,
      ].filter(Boolean).join('\n');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} | Portfolio</title>
<meta name="description" content="${description}">
${social}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/portfolio.css">
</head><body class="tpl-${template} pal-${theme}">
${draft ? '<div class="draft-banner">Draft: only you can see this page. Publish it from the editor when you are ready.</div>' : ''}
<div class="site">
<header class="intro">
  <h1>${name}</h1>
  ${user.bio ? `<p class="bio">${esc(user.bio)}</p>` : ''}
  ${links.length ? `<p class="links">${links.join('')}</p>` : ''}
  ${filters}
</header>
${shown.length ? `<main class="works">${items}</main>` : '<p class="empty">No work posted yet.</p>'}
</div>
<footer class="foot">Made with <a href="/">Artfolio</a></footer>
<script src="/portfolio.js"></script>
</body></html>`;
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  const ip = S.clientIp(req);
  const ipk = S.ipKey(ip);

  // CSRF defense for state-changing requests: require a custom header
  // (cross-site forms cannot set it), on top of SameSite=Lax cookies.
  if (m !== 'GET' && req.headers['x-requested-with'] !== 'artfolio') throw new HttpError(403, 'Bad request origin');

  if (m === 'POST' && p === '/api/signup') {
    const refundIp = S.takeAll([L.signupIp, ipk]); // counts attempts; refunded only if the input was invalid
    const b = await readJson(req);
    let refundSite = null;
    try {
      const username = cleanText(b.username ?? '', 30, 'Username');
      if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) throw new HttpError(400, 'Username must be 3-30 letters, numbers, - or _');
      const email = cleanAccountEmail(b.email);
      if (!email) throw new HttpError(400, 'Please enter your email address. It is only used to reset your password.');
      const pwError = S.checkPassword(b.password, username);
      if (pwError) throw new HttpError(400, pwError);
      checkUsernameFree(username);
      refundSite = S.takeAll([L.signupAll, 'all']);
      const { salt, hash } = await S.hashPassword(b.password, { key: ipk });
      // everything below is synchronous: re-check the name (someone may have registered it during the hash) and insert
      const key = checkUsernameFree(username);
      const id = Number(
        db.prepare('INSERT INTO users (username, username_key, display_name, theme, pw_salt, pw_hash, pending_email, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(username, key, username, 'chalk', salt, hash, email, Date.now()).lastInsertRowid
      );
      audit(id, 'signup', req);
      const user = { id, username };
      sendMail(email, emails.verify(issueCode(id, 'verify', email), user));
      return json(req, res, 201, { ok: true, username }, { 'Set-Cookie': signIn(req, id) });
    } catch (e) {
      refundSite?.();
      if (e instanceof HttpError && e.status === 400) refundIp(); // typos shouldn't use up the hourly signup budget
      throw e;
    }
  }

  if (m === 'POST' && p === '/api/login') {
    const b = await readJson(req);
    const ident = String(b.username ?? '').trim().toLowerCase().slice(0, 120);
    const password = String(b.password ?? '');
    // Never answer faster than a real password check, so timing doesn't reveal which names exist.
    return atLeast(Math.max(AUTH_MIN_MS, S.hashTimeEstimate() * 1.5), async () => {
      const row = ident.includes('@')
        ? db.prepare('SELECT * FROM users WHERE email = ?').get(ident)
        : db.prepare('SELECT * FROM users WHERE username = ?').get(ident);
      const device = row && recognizedDevice(req, row.id);
      const acct = row ? 'u' + row.id : 'n:' + ident;
      const refund = device
        ? S.takeAll([L.loginPair, `${device}|${acct}`])
        : S.takeAll([L.loginIp, ipk], [row ? L.loginAcct : L.loginUnknown, acct], [L.loginPair, `${ipk}|${acct}`]);
      // Names that aren't accounts cost no hashing at all (the response-time floor hides the difference),
      // so a flood of made-up usernames can't tie up the password-hashing queue for real users.
      const v = row ? await S.verifyPassword(password, row.pw_salt, row.pw_hash, { key: ipk }) : { ok: false };
      if (!v.ok) {
        if (row) audit(row.id, 'login_failed', req);
        throw new HttpError(401, 'Wrong username or password');
      }
      refund();
      if (v.upgrade) {
        const n = await S.hashPassword(password, { key: ipk });
        db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(n.salt, n.hash, row.id);
      }
      audit(row.id, 'login', req);
      return json(req, res, 200, { ok: true, username: row.username }, { 'Set-Cookie': signIn(req, row.id) });
    });
  }

  // Forgot your password? Step 1: we email a one-time code to the account's confirmed address.
  // The answer is always the same, so this can't be used to find out which emails have accounts.
  if (m === 'POST' && p === '/api/password-reset/request') {
    const b = await readJson(req);
    return atLeast(AUTH_MIN_MS, async () => {
      S.takeAll([L.resetReqIp, ipk]);
      const email = cleanAccountEmail(b.email);
      if (!email) throw new HttpError(400, 'Please enter your email address');
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (row && L.resetReqAcct.take('u' + row.id)) {
        sendMail(email, emails.reset(issueCode(row.id, 'reset', email), row, email));
        audit(row.id, 'reset_requested', req);
      }
      return json(req, res, 200, { ok: true });
    });
  }

  // Step 2: the code from the email + a new password.
  if (m === 'POST' && p === '/api/password-reset/confirm') {
    const refundIp = S.takeAll([L.resetTryIp, ipk]);
    const b = await readJson(req);
    const email = cleanAccountEmail(b.email);
    const row = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    const pwError = S.checkPassword(b.newPassword, row?.username || '');
    if (pwError) {
      refundIp();
      throw new HttpError(400, pwError);
    }
    // useCode is synchronous and deletes the code, so two parallel requests can't both use it
    if (!row || !useCode(row.id, 'reset', b.code)) throw new HttpError(400, 'That code is wrong or has expired. Ask for a new one.');
    refundIp();
    const { salt, hash } = await S.hashPassword(b.newPassword, { key: ipk });
    db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, row.id);
    db.prepare("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'reset'").run(row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id); // sign out everywhere
    db.prepare('DELETE FROM devices WHERE user_id = ?').run(row.id);
    for (const k of [L.loginAcct, L.resetReqAcct]) k.reset('u' + row.id);
    audit(row.id, 'password_reset', req);
    sendMail(row.email, emails.passwordChanged(row));
    return json(req, res, 200, { ok: true, username: row.username }, { 'Set-Cookie': signIn(req, row.id) });
  }

  if (m === 'POST' && p === '/api/logout') {
    const t = parseCookies(req)[SESSION_COOKIE];
    if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
    return json(req, res, 200, { ok: true }, { 'Set-Cookie': clearSession() });
  }

  // everything below requires login
  const user = getUser(req);
  if (!user) throw new HttpError(401, 'Please log in');
  const userKey = 'u' + user.id;
  // Wrong current password counts against the user; a right one is refunded.
  async function checkCurrentPassword(given, message = 'Password is wrong') {
    const refund = S.takeAll([L.sensitive, userKey]);
    const v = await S.verifyPassword(String(given ?? ''), user.pw_salt, user.pw_hash, { key: userKey });
    if (!v.ok) throw new HttpError(401, message);
    refund();
  }

  if (m === 'GET' && p === '/api/me') {
    const { collections, works } = loadPortfolio(user.id, { includeHidden: true });
    return json(req, res, 200, { user: selfUser(user), collections, works: works.map(apiWork), storage: { used: usage(user.id), limit: USER_QUOTA } });
  }

  if (m === 'GET' && p === '/api/activity') {
    const rows = db.prepare('SELECT ts, event, ip, detail FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id);
    return json(req, res, 200, { events: rows });
  }

  if (m === 'PATCH' && p === '/api/profile') {
    const b = await readJson(req);
    const displayName = b.displayName !== undefined ? cleanText(b.displayName, 60, 'Name') : user.display_name;
    const next = {
      display_name: displayName,
      display_key: b.displayName !== undefined ? checkDisplayName(displayName, user) : user.display_key,
      bio: b.bio !== undefined ? cleanText(b.bio, 600, 'Bio', { multiline: true }) : user.bio,
      template: b.template !== undefined ? b.template : user.template,
      theme: b.theme !== undefined ? b.theme : user.theme,
      contact_email: b.contactEmail !== undefined ? cleanEmail(b.contactEmail, 'Contact email') : user.contact_email,
      website: b.website !== undefined ? cleanUrl(b.website) : user.website,
      instagram: b.instagram !== undefined ? cleanInstagram(b.instagram) : user.instagram,
      published: user.published,
    };
    if (b.published !== undefined) {
      if (typeof b.published !== 'boolean') throw new HttpError(400, 'published must be true or false');
      next.published = b.published ? 1 : 0;
    }
    if (!TEMPLATES.includes(next.template)) throw new HttpError(400, 'Unknown template');
    if (!THEMES.includes(next.theme)) throw new HttpError(400, 'Unknown color palette');
    db.prepare(
      'UPDATE users SET display_name=?, display_key=?, bio=?, template=?, theme=?, contact_email=?, website=?, instagram=?, published=? WHERE id=?'
    ).run(next.display_name, next.display_key, next.bio, next.template, next.theme, next.contact_email, next.website, next.instagram, next.published, user.id);
    if (next.published !== user.published) audit(user.id, next.published ? 'published' : 'unpublished', req);
    return json(req, res, 200, { ok: true, user: selfUser({ ...user, ...next }) });
  }

  if (m === 'POST' && p === '/api/password') {
    const b = await readJson(req);
    await checkCurrentPassword(b.current, 'Current password is wrong');
    const pwError = S.checkPassword(b.next, user.username);
    if (pwError) throw new HttpError(400, pwError);
    const { salt, hash } = await S.hashPassword(b.next, { key: userKey });
    db.prepare('UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?').run(salt, hash, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // every session, this one included...
    audit(user.id, 'password_changed', req);
    if (user.email) sendMail(user.email, emails.passwordChanged(user));
    return json(req, res, 200, { ok: true }, { 'Set-Cookie': createSession(user.id) }); // ...then a fresh one for this device
  }

  // ----- account email -----
  if (m === 'POST' && p === '/api/email') {
    const b = await readJson(req);
    const email = cleanAccountEmail(b.email);
    if (!email) throw new HttpError(400, 'Please enter an email address');
    await checkCurrentPassword(b.password);
    if (email === user.email) throw new HttpError(400, 'That is already your email');
    if (!L.verifySend.take(userKey)) throw new HttpError(429, 'Too many emails sent. Please wait a while and try again.');
    db.prepare('UPDATE users SET pending_email = ? WHERE id = ?').run(email, user.id);
    sendMail(email, emails.verify(issueCode(user.id, 'verify', email), user));
    if (user.email) sendMail(user.email, emails.emailChanging(user, email));
    audit(user.id, 'email_change_requested', req);
    return json(req, res, 200, { ok: true, pendingEmail: email });
  }
  if (m === 'POST' && p === '/api/email/resend') {
    if (!user.pending_email) throw new HttpError(400, 'There is no email waiting to be confirmed');
    if (!L.verifySend.take(userKey)) throw new HttpError(429, 'Too many emails sent. Please wait a while and try again.');
    sendMail(user.pending_email, emails.verify(issueCode(user.id, 'verify', user.pending_email), user));
    return json(req, res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/email/verify') {
    const refund = S.takeAll([L.verifyTry, userKey]);
    const b = await readJson(req);
    const hit = useCode(user.id, 'verify', b.code);
    if (!hit || hit.email !== user.pending_email) throw new HttpError(400, 'That code is wrong or has expired. You can send a new one.');
    refund();
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(hit.email, user.id)) {
      db.prepare("UPDATE users SET pending_email = '' WHERE id = ?").run(user.id);
      throw new HttpError(409, 'That email already belongs to another Artfolio account');
    }
    db.prepare("UPDATE users SET email = ?, pending_email = '' WHERE id = ?").run(hit.email, user.id);
    db.prepare("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'verify'").run(user.id);
    audit(user.id, 'email_verified', req, hit.email);
    return json(req, res, 200, { ok: true, email: hit.email });
  }
  if (m === 'DELETE' && p === '/api/email/pending') {
    db.prepare("UPDATE users SET pending_email = '' WHERE id = ?").run(user.id);
    db.prepare("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'verify'").run(user.id);
    return json(req, res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/sessions/revoke-others') {
    const current = sha(parseCookies(req)[SESSION_COOKIE] || '');
    const info = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, current);
    audit(user.id, 'other_sessions_revoked', req, String(info.changes));
    return json(req, res, 200, { ok: true, revoked: Number(info.changes) });
  }

  if (m === 'DELETE' && p === '/api/account') {
    const b = await readJson(req);
    await checkCurrentPassword(b.password);
    const files = db.prepare('SELECT i.filename, i.thumb FROM images i JOIN works w ON w.id = i.work_id WHERE w.user_id = ?').all(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // cascades to sessions, devices, codes, collections, works, images, audit
    removeFiles(files);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return json(req, res, 200, { ok: true }, { 'Set-Cookie': clearSession() });
  }

  // ----- collections -----
  if (m === 'POST' && p === '/api/collections') {
    const b = await readJson(req);
    const name = cleanText(b.name ?? '', 40, 'Collection name');
    if (!name) throw new HttpError(400, 'Give the collection a name');
    if (db.prepare('SELECT COUNT(*) c FROM collections WHERE user_id = ?').get(user.id).c >= LIMITS.collections)
      throw new HttpError(400, `You can have up to ${LIMITS.collections} collections`);
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 n FROM collections WHERE user_id = ?').get(user.id).n;
    const info = db.prepare('INSERT INTO collections (user_id, name, position) VALUES (?,?,?)').run(user.id, name, pos);
    return json(req, res, 201, { id: Number(info.lastInsertRowid), name });
  }
  const cm = p.match(/^\/api\/collections\/(\d+)$/);
  if (cm) {
    const id = Number(cm[1]);
    if (m === 'PATCH') {
      const name = cleanText((await readJson(req)).name ?? '', 40, 'Collection name');
      if (!name) throw new HttpError(400, 'Give the collection a name');
      if (!db.prepare('UPDATE collections SET name = ? WHERE id = ? AND user_id = ?').run(name, id, user.id).changes) throw new HttpError(404, 'Not found');
      return json(req, res, 200, { ok: true, name });
    }
    if (m === 'DELETE') {
      // works fall back to "no collection"
      if (!db.prepare('DELETE FROM collections WHERE id = ? AND user_id = ?').run(id, user.id).changes) throw new HttpError(404, 'Not found');
      return json(req, res, 200, { ok: true });
    }
  }

  // ----- works and images -----
  if (m === 'POST' && p === '/api/images') {
    // Raw image body. ?work=<id> adds to an existing piece; otherwise a new piece is created.
    const release = uploadSlot(user.id);
    let buf;
    try {
      buf = await readBody(req, MAX_UPLOAD, 'That file is too large (max 10 MB)');
    } finally {
      release();
    }
    // From here on everything is synchronous: limits, quota, file write and database insert can't interleave.
    let workId = url.searchParams.get('work');
    if (workId !== null) {
      workId = Number(workId);
      if (!db.prepare('SELECT 1 FROM works WHERE id = ? AND user_id = ?').get(workId, user.id)) throw new HttpError(404, 'Not found');
      if (db.prepare('SELECT COUNT(*) c FROM images WHERE work_id = ?').get(workId).c >= LIMITS.imagesPerWork)
        throw new HttpError(400, `A piece can have up to ${LIMITS.imagesPerWork} images`);
    } else if (db.prepare('SELECT COUNT(*) c FROM works WHERE user_id = ?').get(user.id).c >= LIMITS.works) {
      throw new HttpError(400, `Portfolio is full (${LIMITS.works} works max)`);
    }
    const title = workId === null ? cleanText(url.searchParams.get('title') || '', 120, 'Title') : '';
    const { filename, bytes } = storeImage(buf, user.id);
    try {
      tx(() => {
        if (workId === null) {
          const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 n FROM works WHERE user_id = ?').get(user.id).n;
          workId = Number(db.prepare('INSERT INTO works (user_id, title, position, created_at) VALUES (?,?,?,?)').run(user.id, title, pos, Date.now()).lastInsertRowid);
        }
        const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 n FROM images WHERE work_id = ?').get(workId).n;
        db.prepare('INSERT INTO images (work_id, filename, position, bytes) VALUES (?,?,?,?)').run(workId, filename, pos, bytes);
      });
    } catch (e) {
      fs.rmSync(path.join(UPLOAD_DIR, filename), { force: true });
      throw e;
    }
    const work = loadPortfolio(user.id, { includeHidden: true }).works.find((w) => w.id === workId);
    return json(req, res, 201, apiWork(work));
  }

  const tm = p.match(/^\/api\/images\/(\d+)\/thumb$/);
  if (m === 'PUT' && tm) {
    const imageId = Number(tm[1]);
    const own = (id) => db.prepare('SELECT i.* FROM images i JOIN works w ON w.id = i.work_id WHERE i.id = ? AND w.user_id = ?').get(id, user.id);
    if (!own(imageId)) throw new HttpError(404, 'Not found');
    const release = uploadSlot(user.id);
    let buf;
    try {
      buf = await readBody(req, MAX_UPLOAD, 'That file is too large (max 10 MB)');
    } finally {
      release();
    }
    // Re-read the row AFTER the upload arrived: it may have changed or been deleted meanwhile.
    // Everything from here is synchronous, so the old thumbnail we remove is exactly the one we replace.
    const img = own(imageId);
    if (!img) throw new HttpError(404, 'Not found');
    const { filename, bytes } = storeImage(buf, user.id, img.thumb_bytes);
    db.prepare('UPDATE images SET thumb = ?, thumb_bytes = ? WHERE id = ?').run(filename, bytes, img.id);
    removeFiles([{ filename: img.thumb }]);
    return json(req, res, 200, { ok: true, thumb: `/img/${filename}` });
  }

  const im = p.match(/^\/api\/images\/(\d+)$/);
  if (m === 'DELETE' && im) {
    const img = db
      .prepare('SELECT i.* FROM images i JOIN works w ON w.id = i.work_id WHERE i.id = ? AND w.user_id = ?')
      .get(Number(im[1]), user.id);
    if (!img) throw new HttpError(404, 'Not found');
    if (db.prepare('SELECT COUNT(*) c FROM images WHERE work_id = ?').get(img.work_id).c <= 1)
      throw new HttpError(400, 'A piece needs at least one image. Delete the whole piece instead.');
    db.prepare('DELETE FROM images WHERE id = ?').run(img.id);
    removeFiles([img]);
    return json(req, res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/works/reorder') {
    const b = await readJson(req);
    if (!Array.isArray(b.ids) || b.ids.some((i) => !Number.isInteger(i))) throw new HttpError(400, 'ids must be a list of numbers');
    const own = new Set(db.prepare('SELECT id FROM works WHERE user_id = ?').all(user.id).map((r) => r.id));
    // must be exactly the user's works, each once (a partial list would leave duplicate positions)
    if (b.ids.length !== own.size || new Set(b.ids).size !== b.ids.length || b.ids.some((i) => !own.has(i)))
      throw new HttpError(409, 'Your list of works is out of date. Reload the page and try again.');
    const upd = db.prepare('UPDATE works SET position = ? WHERE id = ? AND user_id = ?');
    tx(() => b.ids.forEach((id, idx) => upd.run(idx + 1, id, user.id)));
    return json(req, res, 200, { ok: true });
  }

  const wm = p.match(/^\/api\/works\/(\d+)$/);
  if (wm) {
    const id = Number(wm[1]);
    if (m === 'PATCH') {
      const b = await readJson(req);
      const work = db.prepare('SELECT * FROM works WHERE id = ? AND user_id = ?').get(id, user.id);
      if (!work) throw new HttpError(404, 'Not found');
      const title = b.title !== undefined ? cleanText(b.title, 120, 'Title') : work.title;
      const description = b.description !== undefined ? cleanText(b.description, 2000, 'Description', { multiline: true }) : work.description;
      let collectionId = work.collection_id;
      if (b.collectionId !== undefined) {
        if (b.collectionId !== null && !Number.isInteger(b.collectionId)) throw new HttpError(400, 'Unknown collection');
        collectionId = b.collectionId;
        if (collectionId !== null && !db.prepare('SELECT 1 FROM collections WHERE id = ? AND user_id = ?').get(collectionId, user.id))
          throw new HttpError(400, 'Unknown collection');
      }
      let hidden = work.hidden;
      if (b.hidden !== undefined) {
        if (typeof b.hidden !== 'boolean') throw new HttpError(400, 'hidden must be true or false');
        hidden = b.hidden ? 1 : 0;
      }
      db.prepare('UPDATE works SET title=?, description=?, collection_id=?, hidden=? WHERE id=?').run(title, description, collectionId, hidden, id);
      return json(req, res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      if (!db.prepare('SELECT 1 FROM works WHERE id = ? AND user_id = ?').get(id, user.id)) throw new HttpError(404, 'Not found');
      const files = db.prepare('SELECT filename, thumb FROM images WHERE work_id = ?').all(id);
      db.prepare('DELETE FROM works WHERE id = ?').run(id);
      removeFiles(files);
      return json(req, res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}

// Serve a file with an ETag so browsers can revalidate cheaply (304) instead of trusting a stale copy.
function serveFile(req, res, file, cache, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = { 'Cache-Control': cache, ETag: etag, ...extra };
    if (req.headers['if-none-match'] === etag) return send(req, res, 304, '', headers);
    fs.readFile(file, (err2, data) => {
      if (err2) return send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      send(req, res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...headers });
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // In production behind a trusted TLS-terminating proxy, plain-HTTP requests are redirected to HTTPS.
    if (PRODUCTION && S.TRUST_PROXY > 0 && !isSecure(req)) {
      const host = String(req.headers.host || '');
      if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new HttpError(400, 'Bad host');
      return send(req, res, 308, '', { Location: `https://${host}${req.url}` });
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

    // Uploaded images. Only plain hex filenames; each must belong to a visible piece unless its owner is asking.
    const im = p.match(/^\/img\/([a-f0-9]{32}\.(?:jpg|png|webp|gif))$/);
    if (im) {
      const row = db
        .prepare(
          `SELECT w.user_id, w.hidden, u.published FROM images i JOIN works w ON w.id = i.work_id JOIN users u ON u.id = w.user_id
           WHERE i.filename = ? OR i.thumb = ?`
        )
        .get(im[1], im[1]);
      if (!row) throw new HttpError(404, 'Not found');
      const isPublic = row.published && !row.hidden;
      if (!isPublic && getUser(req)?.id !== row.user_id) throw new HttpError(404, 'Not found');
      // Public images: "no-cache" = browsers and CDNs must check with us before reusing a copy (a cheap 304),
      // so hiding a piece, unpublishing or deleting takes effect on the next view instead of a day later.
      return serveFile(req, res, path.join(UPLOAD_DIR, im[1]), isPublic ? 'public, no-cache' : 'private, no-store', isPublic ? {} : { Vary: 'Cookie' });
    }

    const um = p.match(/^\/u\/([A-Za-z0-9_-]{3,30})\/?$/);
    if (um) {
      const u = db.prepare('SELECT * FROM users WHERE username = ?').get(um[1]);
      const viewer = u && !u.published ? getUser(req) : null;
      const draft = !!u && !u.published;
      if (!u || (draft && viewer?.id !== u.id)) throw new HttpError(404, 'No such portfolio'); // same answer for "unpublished" and "doesn't exist"
      if (um[1] !== u.username || p.endsWith('/')) // one address per portfolio: /u/FRIDA and /u/frida/ -> /u/Frida
        return send(req, res, 301, '', { Location: `/u/${encodeURIComponent(u.username)}${url.search}` });
      const { collections, works } = loadPortfolio(u.id, { includeHidden: false });
      return send(req, res, 200, renderPortfolio(u, collections, works, { draft }), {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': draft ? 'private, no-store' : 'no-cache',
      });
    }

    // static app shell
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');
    return serveFile(req, res, file, 'no-cache');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    const msg = status === 500 ? 'Server error' : e.message;
    if (res.headersSent) return res.destroy();
    if (req.url.startsWith('/api/')) return json(req, res, status, { error: msg });
    send(req, res, status, `<!doctype html><title>${status}</title><p style="font:16px system-ui;padding:40px">${esc(msg)} · <a href="/">Home</a></p>`, {
      'Content-Type': 'text/html; charset=utf-8',
    });
  }
});

// ---------- housekeeping ----------
// Expired sessions/devices/codes, stale rate-limit keys, audit entries older than 90 days, and upload
// files no database row points to (e.g. left behind by a crash mid-upload).
function sweepOrphanFiles(minAgeMs = 10 * MIN) {
  const used = new Set();
  for (const r of db.prepare('SELECT filename, thumb FROM images').all()) {
    used.add(r.filename);
    if (r.thumb) used.add(r.thumb);
  }
  let removed = 0;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (used.has(f) || !/^[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(f)) continue;
    const file = path.join(UPLOAD_DIR, f);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs >= minAgeMs) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch {
      /* already gone */
    }
  }
  return removed;
}
let sweeps = 0;
function housekeeping() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM devices WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM email_codes WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM audit WHERE ts < ?').run(now - 90 * 86400e3);
  limiters.forEach((l) => l.sweep());
  if (sweeps++ % 6 === 0) sweepOrphanFiles(); // hourly
}
setInterval(housekeeping, 10 * MIN).unref();
housekeeping();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Artfolio running at http://localhost:${server.address().port}`);
    if (mail.transport === 'log') console.log(`Email is not configured (no SMTP_URL): messages are written to ${path.join(DATA_DIR, 'outbox')} instead of sent.`);
  });
}
module.exports = { server, limiters, L, housekeeping, sweepOrphanFiles, USER_QUOTA, mail };
