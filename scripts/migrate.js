// Apply or revert schema migrations, one file per step:
//   migrations/NNN_name.up.sql   and   migrations/NNN_name.down.sql
// `up` applies every pending step; `down` reverts the LAST applied step only.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, DB_PATH } from '../src/db.js';

// fileURLToPath, not URL.pathname: on Windows pathname is "/D:/..." and the
// leading slash makes readdirSync resolve it against the current drive.
const DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const db = open();
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');

const files = readdirSync(DIR).filter((f) => f.endsWith('.up.sql')).sort();
const versions = files.map((f) => f.replace('.up.sql', ''));
const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));

function run(sql, after) {
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(sql); after(); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const cmd = process.argv[2] ?? 'status';
if (cmd === 'up') {
  const pending = versions.filter((v) => !applied.has(v));
  if (!pending.length) console.log('nothing to apply');
  for (const v of pending) {
    run(readFileSync(join(DIR, `${v}.up.sql`), 'utf8'), () =>
      db.prepare("INSERT INTO schema_migrations VALUES (?, datetime('now'))").run(v));
    console.log(`applied  ${v}`);
  }
} else if (cmd === 'down') {
  const last = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  if (!last) { console.log('nothing to revert'); process.exit(0); }
  const file = join(DIR, `${last.version}.down.sql`);
  if (!existsSync(file)) { console.error(`no ${last.version}.down.sql — this step has no way back`); process.exit(1); }
  run(readFileSync(file, 'utf8'), () => db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(last.version));
  console.log(`reverted ${last.version}`);
} else {
  console.log(`db ${DB_PATH}`);
  for (const v of versions) console.log(`${applied.has(v) ? '[x]' : '[ ]'} ${v}`);
}
