'use strict';
// Sending email with no dependencies: a small SMTP client (implicit TLS or STARTTLS, AUTH PLAIN/LOGIN),
// or a "log" transport for development that writes each message to an outbox folder.
//
//   SMTP_URL=smtps://USER:PASS@smtp.example.com:465    TLS from the first byte
//   SMTP_URL=smtp://USER:PASS@smtp.example.com:587     STARTTLS (required; the connection fails without it)
//   SMTP_URL=smtp://localhost:1025?tls=off             plain text, only for a local test mail catcher
// Most providers (Postmark, SendGrid, Mailgun, Amazon SES, Resend, Fastmail, Gmail app passwords...) offer SMTP.
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TIMEOUT = 20000;

function parseUrl(url) {
  const u = new URL(url);
  if (!['smtp:', 'smtps:'].includes(u.protocol)) throw new Error('SMTP_URL must start with smtp:// or smtps://');
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587),
    secure: u.protocol === 'smtps:',
    plain: u.searchParams.get('tls') === 'off',
    user: decodeURIComponent(u.username),
    pass: decodeURIComponent(u.password),
  };
}

// "Artfolio <hello@example.com>" -> { name, address }
function parseFrom(from) {
  const m = String(from).match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/) || String(from).match(/^\s*()([^<>\s]+@[^<>\s]+)\s*$/);
  if (!m) throw new Error('MAIL_FROM must look like "Artfolio <hello@example.com>"');
  return { name: (m[1] || '').trim(), address: m[2] };
}

const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const noCrlf = (s) => String(s).replace(/[\r\n]+/g, ' ');

function buildMessage({ from, to, subject, text }) {
  const f = parseFrom(from);
  const domain = f.address.split('@')[1];
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    `From: ${f.name ? `${encodeWord(noCrlf(f.name))} <${f.address}>` : f.address}`,
    `To: ${noCrlf(to)}`,
    `Subject: ${encodeWord(noCrlf(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

// One SMTP conversation. Resolves when the server accepts the message.
function smtpSend(cfg, envelopeFrom, to, message) {
  return new Promise((resolve, reject) => {
    let sock, buf = '', lines = [], waiting = null, done = false;
    const replies = [];
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock?.destroy();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('SMTP timed out')), TIMEOUT * 3);
    const onData = (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(line);
        if (/^\d{3}(?: |$)/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
          lines = [];
          if (waiting) { const w = waiting; waiting = null; w(reply); } else replies.push(reply);
        }
      }
    };
    const attach = (s) => {
      s.setTimeout(TIMEOUT, () => finish(new Error('SMTP connection idle too long')));
      s.on('data', onData);
      s.on('error', finish);
    };
    const read = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((r) => (waiting = r)));
    const expect = async (codes, what) => {
      const r = await read();
      if (!codes.includes(r.code)) throw new Error(`SMTP ${what} failed: ${r.text}`);
      return r;
    };
    const cmd = (line, codes, what = line.split(' ')[0]) => {
      sock.write(line + '\r\n');
      return expect(codes, what);
    };

    (async () => {
      sock = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
      attach(sock);
      await expect([220], 'greeting');
      const ehloName = 'artfolio.local';
      let ehlo = await cmd(`EHLO ${ehloName}`, [250]);
      if (!cfg.secure && !cfg.plain) {
        if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP server does not offer STARTTLS; refusing to send in plain text');
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        sock = await new Promise((res, rej) => {
          const t = tls.connect({ socket: sock, servername: cfg.host }, () => res(t));
          t.once('error', rej);
        });
        attach(sock);
        ehlo = await cmd(`EHLO ${ehloName}`, [250]);
      }
      if (cfg.user) {
        if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
          await cmd('AUTH PLAIN ' + Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64'), [235], 'AUTH');
        } else {
          await cmd('AUTH LOGIN', [334], 'AUTH');
          await cmd(Buffer.from(cfg.user).toString('base64'), [334], 'AUTH');
          await cmd(Buffer.from(cfg.pass).toString('base64'), [235], 'AUTH');
        }
      }
      await cmd(`MAIL FROM:<${envelopeFrom}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      // dot-stuffing: a line starting with "." gets a second one
      sock.write(message.replace(/^\./gm, '..') + '\r\n.\r\n');
      await expect([250], 'message');
      sock.write('QUIT\r\n');
      finish();
    })().catch(finish);
  });
}

function createMailer({ url, from, outbox, log = console }) {
  const transport = url ? 'smtp' : 'log';
  const cfg = url ? parseUrl(url) : null;
  const sender = parseFrom(from);
  if (cfg && cfg.plain && !['localhost', '127.0.0.1', '::1'].includes(cfg.host)) log.warn('Warning: SMTP_URL has tls=off for a remote host; email will travel unencrypted.');

  async function sendNow(to, subject, text) {
    const message = buildMessage({ from, to, subject, text });
    if (transport === 'log') {
      fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
      const file = path.join(outbox, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.eml`);
      fs.writeFileSync(file, message, { mode: 0o600 });
      log.log(`[mail] (not sent, no SMTP_URL) "${subject}" to ${to} -> ${file}`);
      return;
    }
    await smtpSend(cfg, sender.address, to, message);
  }

  // Fire and forget, with two retries. Callers never wait for delivery, so response times don't
  // reveal whether an email was sent (and a slow mail server doesn't slow the site).
  function send(to, subject, text) {
    const attempt = (n) =>
      sendNow(to, subject, text).catch((e) => {
        if (n < 2) setTimeout(() => attempt(n + 1), 5000 * (n + 1)).unref();
        else log.error(`[mail] could not send "${subject}" to ${to}: ${e.message}`);
      });
    attempt(0);
  }
  return { send, sendNow, transport };
}

module.exports = { createMailer, buildMessage, parseFrom, parseUrl };
