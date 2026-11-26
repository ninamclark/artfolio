'use strict';
// Passwords, rate limiting, email codes, name handling.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError } = require('./errors');
const scrypt = promisify(crypto.scrypt);

// ---------------- password hashing (async, bounded concurrency) ----------------
// scrypt N=2^15, r=8, p=3 is one of OWASP's equivalent-strength settings (~32 MiB per hash).
// It runs on libuv's thread pool, so the HTTP server keeps answering while a hash is computed.
// Two limits keep a flood from starving everyone else:
//   - a global cap on hashes in progress, with a bounded queue, and
//   - a per-client cap (MAX_PER_KEY), so one IP block or one account can't fill the queue.
const PARAMS = { logN: 15, r: 8, p: 3 };
const LEGACY = { logN: 14, r: 8, p: 1 }; // v1 hashes were bare hex made with Node's defaults
const MAX_CONCURRENT = Number(process.env.HASH_CONCURRENCY) || 4;
const MAX_QUEUE = 200;
const MAX_PER_KEY = 2;
let active = 0;
const queue = [];
const perKey = new Map();

function limited(fn, key) {
  if (key) {
    const n = perKey.get(key) || 0;
    if (n >= MAX_PER_KEY) return Promise.reject(new HttpError(429, 'Too many requests at once. Please wait a moment and try again.'));
    perKey.set(key, n + 1);
  }
  const release = () => {
    if (!key) return;
    const n = perKey.get(key) - 1;
    if (n > 0) perKey.set(key, n);
    else perKey.delete(key);
  };
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          release();
          const next = queue.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else if (queue.length >= MAX_QUEUE) {
      release();
      reject(new HttpError(503, 'The server is busy. Please try again in a moment.'));
    } else queue.push(run);
  });
}
// Moving average of how long a current-strength hash takes, queueing included. Login uses it to pad
// "no such user" answers (which skip hashing entirely) so they take as long as real ones.
let hashMs = 250;
const hashTimeEstimate = () => hashMs;
const derive = (password, salt, { logN, r, p }, key) => {
  const start = Date.now();
  return limited(() => scrypt(password, salt, 64, { N: 2 ** logN, r, p, maxmem: 256 * 1024 * 1024 }), key).then((k) => {
    if (logN === PARAMS.logN && p === PARAMS.p) hashMs = hashMs * 0.8 + (Date.now() - start) * 0.2;
    return k;
  });
};

// Passwords are Unicode-normalized (NFC) so "é" typed on any keyboard or OS hashes the same.
async function hashPassword(password, { key, salt = crypto.randomBytes(16).toString('hex') } = {}) {
  const k = await derive(String(password).normalize('NFC'), salt, PARAMS, key);
  return { salt, hash: `scrypt:${PARAMS.logN}:${PARAMS.r}:${PARAMS.p}:${k.toString('hex')}` };
}

// Returns { ok, upgrade }. `upgrade` means the stored hash should be re-saved (older settings,
// or it was made from a password that wasn't NFC-normalized).
async function verifyPassword(password, salt, stored, { key } = {}) {
  password = String(password);
  let params = LEGACY, hex = stored;
  if (stored.startsWith('scrypt:')) {
    const [, logN, r, p, h] = stored.split(':');
    params = { logN: Number(logN), r: Number(r), p: Number(p) };
    hex = h;
    if (![params.logN, params.r, params.p].every(Number.isInteger) || params.logN > 20) return { ok: false, upgrade: false };
  }
  const matches = async (pw) => {
    const a = Buffer.from((await derive(pw, salt, params, key)).toString('hex')), b = Buffer.from(hex);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const nfc = password.normalize('NFC');
  let ok = await matches(nfc), raw = false;
  if (!ok && nfc !== password) ok = raw = await matches(password); // hashes saved before normalization
  const weaker = params.logN !== PARAMS.logN || params.r !== PARAMS.r || params.p !== PARAMS.p;
  return { ok, upgrade: ok && (weaker || raw) };
}

// ---------------- password policy ----------------
const COMMON = new Set(
  ('password password1 password12 password123 password1234 passw0rd passw0rd1 qwerty qwerty123 qwertyuiop qwertyuiop1 1234567890 12345678910 123456789012 ' +
    'letmein letmein123 iloveyou iloveyou1 welcome welcome123 admin admin123 admin12345 abc123456 abcdefghij 1q2w3e4r5t 1qaz2wsx3edc monkey1234 dragon1234 ' +
    'football1 baseball1 sunshine1 princess1 trustno1 changeme changeme123 artfolio artfolio123 portfolio123 0123456789 9876543210 qazwsxedc123 zaq12wsxcde')
    .split(' ')
);
function checkPassword(pw, username = '') {
  if (typeof pw !== 'string') return 'Password must be text';
  if ([...pw].length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 200) return 'Password is too long (max 200 characters)';
  const low = pw.normalize('NFC').toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/u.test(pw) || /^(0123456789|1234567890|abcdefghij|qwertyuiop|asdfghjkl)/.test(low))
    return 'That password is too common. Try a few unrelated words.';
  if (username.length >= 3 && low.includes(username.toLowerCase())) return "Your password can't contain your username";
  return null;
}

// ---------------- rate limiting ----------------
// Sliding-window counters kept in memory.
// take(key) checks AND records in one synchronous step, so a burst of parallel requests can't all
// slip past the check before any of them is counted. refund(key) gives an attempt back (used when
// the attempt turned out to be a success, so people are never limited by their own successes).
class Limiter {
  // evict: when the table is over `cap`, may old keys be dropped? Never for per-account limiters
  // (their keys are bounded by the number of real accounts), or an attacker could wipe a victim's count.
  constructor(max, windowMs, { cap = 50000, evict = true } = {}) {
    Object.assign(this, { max, windowMs, cap, evict, hits: new Map() });
  }
  _live(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }
  tooMany(key) {
    return this._live(key).length >= this.max;
  }
  take(key) {
    const arr = this._live(key);
    if (arr.length >= this.max) return false;
    if (!this.hits.has(key) && this.hits.size >= this.cap) {
      this.sweep();
      if (this.hits.size >= this.cap) {
        if (!this.evict) return false; // full of live entries: refuse rather than forget someone's count
        // drop the least recently used tenth (Map order = insertion order; touched keys are re-inserted below)
        for (const k of [...this.hits.keys()].slice(0, Math.ceil(this.cap / 10))) this.hits.delete(k);
      }
    }
    arr.push(Date.now());
    this.hits.delete(key); // re-insert so the Map stays in least-recently-used order
    this.hits.set(key, arr);
    return true;
  }
  refund(key) {
    const arr = this.hits.get(key);
    if (!arr) return;
    arr.pop();
    if (!arr.length) this.hits.delete(key);
  }
  reset(key) {
    this.hits.delete(key);
  }
  sweep() {
    const now = Date.now();
    for (const [k, arr] of this.hits) if (!arr.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
  get size() {
    return this.hits.size;
  }
}

// Take one attempt from every [limiter, key] pair, all or nothing. Returns a function that refunds them.
function takeAll(...pairs) {
  const taken = [];
  for (const [lim, key] of pairs) {
    if (!lim.take(key)) {
      for (const [l, k] of taken) l.refund(k);
      throw new HttpError(429, 'Too many attempts. Please wait a while and try again.');
    }
    taken.push([lim, key]);
  }
  return () => taken.splice(0).forEach(([l, k]) => l.refund(k));
}

// Number of reverse proxies in front of the app that you trust to set X-Forwarded-For / -Proto (0 = none).
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY || '0', 10) || 0);
// Proxies append to these headers, so the client-controlled values are on the LEFT.
// The value written by the outermost trusted proxy is TRUST_PROXY places from the right.
function fromTrustedProxy(header) {
  const list = String(header || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list[Math.max(0, list.length - TRUST_PROXY)] : '';
}
function clientIp(req) {
  const direct = req.socket.remoteAddress || 'unknown';
  if (!TRUST_PROXY) return direct;
  return fromTrustedProxy(req.headers['x-forwarded-for']) || direct;
}
const forwardedProto = (req) => (TRUST_PROXY ? fromTrustedProxy(req.headers['x-forwarded-proto']).toLowerCase() : '');

// Rate-limit key for an IP. One IPv6 customer usually controls a whole /64 (2^64 addresses),
// so IPv6 is bucketed by /64; IPv4 (and IPv4-mapped IPv6) by single address.
function ipKey(ip) {
  ip = String(ip || '').split('%')[0];
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

// ---------------- one-time email codes ----------------
// 8 characters from a 30-symbol alphabet (~39 bits). Codes expire within minutes and die after
// a handful of wrong tries, so guessing is hopeless. Stored only as a hash.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no I, L, O, U, 0, 1
function newCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]; // unbiased
  return s.slice(0, 4) + '-' + s.slice(4);
}
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
const hashCode = (purpose, userId, code) =>
  crypto.createHash('sha256').update(`artfolio-code:${purpose}:${userId}:${normalizeCode(code)}`).digest('hex');
function hashesEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------- text and names ----------------
// Invisible/bidi/blank characters can disguise names ("admin" + zero-width char), flip text direction,
// or render as nothing at all (Hangul fillers, braille blank). ZWJ (U+200D) is kept: emoji need it.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​‌‎‏‪-‮⁠-⁯⠀ㅤ﻿ﾠ￹-￻]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
function cleanText(v, max, field, { multiline = false } = {}) {
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  let t = v.normalize('NFC').replace(INVISIBLE, '').replace(CONTROL, '');
  t = multiline ? t.replace(/\r\n?/g, '\n') : t.replace(/\s+/g, ' ');
  t = t.trim();
  if ([...t].length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return t;
}
// At least one letter, number, symbol or punctuation mark (so a name can't render as blank).
const hasVisible = (s) => /[\p{L}\p{N}\p{S}\p{P}]/u.test(s);

// Strict on purpose: no "?", "&", "=" or "%" so it can never smuggle subject/body/cc fields into a
// mailto: link or an email header; no leading, trailing or doubled dots.
const EMAIL_RE = /^[A-Za-z0-9_+-]+(\.[A-Za-z0-9_+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
const validEmail = (s) => typeof s === 'string' && s.length <= 120 && s.split('@')[0].length <= 64 && EMAIL_RE.test(s);

const CONFUSABLE = Object.fromEntries(
  'а:a е:e о:o р:p с:c х:x у:y к:k м:m т:t в:b н:h і:i ј:j ѕ:s ο:o α:a ε:e ι:i κ:k ν:v ρ:p τ:t υ:u χ:x'.split(' ').map((p) => [p[0], p[2]])
);
// Reduce a name to a "skeleton" so lookalikes collide: case, accents, punctuation, 0/o, 1/l/i, rn/m, vv/w, Cyrillic/Greek twins...
function skeleton(name) {
  let t = String(name).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  t = [...t].map((c) => CONFUSABLE[c] || c).join('');
  t = t.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[^\p{L}\p{N}]+/gu, '');
  return t.replace(/0/g, 'o').replace(/[1i]/g, 'l').replace(/5/g, 's').replace(/3/g, 'e').replace(/4/g, 'a').replace(/7/g, 't').replace(/8/g, 'b');
}
const mixesScripts = (s) => /\p{Script=Latin}/u.test(s) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(s);

const RESERVED = ('admin administrator root support help staff team moderator mod official security login logout signin signup register settings account accounts ' +
  'www mail email about terms privacy contact billing api img u static assets favicon artfolio portfolio gallery abuse postmaster webmaster null undefined anonymous system').split(' ');
const RESERVED_KEYS = new Set(RESERVED.map(skeleton));

module.exports = {
  hashPassword, verifyPassword, checkPassword, hashTimeEstimate,
  Limiter, takeAll, TRUST_PROXY, clientIp, forwardedProto, ipKey,
  newCode, normalizeCode, hashCode, hashesEqual,
  cleanText, hasVisible, validEmail, skeleton, mixesScripts, RESERVED_KEYS,
};
