'use strict';
// Consistent backup of the database and all uploaded images.
//   node scripts/backup.js [destination-folder]      (default: ./backups, which is git-ignored)
// Safe to run while the server is running. Every image the backed-up database refers to is in the backup:
//   1. copy the upload folder,
//   2. snapshot the database (SQLite VACUUM INTO),
//   3. copy any image the snapshot refers to that arrived after step 1.
// (An image deleted after step 1 is simply an extra file in the backup; the server cleans those up.)
// To restore: stop the server, then copy artfolio.db and uploads/ from a backup into your data folder.
process.umask(0o077);
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'artfolio.db');
const UPLOADS = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(DB_FILE) || !fs.existsSync(UPLOADS)) {
  console.error(`No Artfolio data found in ${DATA_DIR} (expected artfolio.db and uploads/). Set DATA_DIR to your data folder.`);
  process.exit(1);
}

const dest = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(dest, stamp);
const outUploads = path.join(out, 'uploads');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });

// 1. images
fs.cpSync(UPLOADS, outUploads, { recursive: true });

// 2. database snapshot
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA busy_timeout = 10000');
const snapshot = path.join(out, 'artfolio.db');
db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
db.close();

// 3. images referenced by the snapshot but not copied yet
const snap = new DatabaseSync(snapshot);
const wanted = new Set();
for (const r of snap.prepare('SELECT filename, thumb FROM images').all()) {
  wanted.add(r.filename);
  if (r.thumb) wanted.add(r.thumb);
}
snap.close();
const missing = [];
for (const f of wanted) {
  if (fs.existsSync(path.join(outUploads, f))) continue;
  try {
    fs.copyFileSync(path.join(UPLOADS, f), path.join(outUploads, f));
  } catch {
    missing.push(f);
  }
}

const n = fs.readdirSync(outUploads).length;
console.log(`Backup written to ${out} (database + ${n} image files).`);
if (missing.length) console.warn(`Warning: ${missing.length} image file(s) in the database could not be copied (missing from ${UPLOADS}, or deleted while the backup ran).`);
console.log('Keep backups somewhere other than this server. They contain private data (password hashes, emails, drafts).');
