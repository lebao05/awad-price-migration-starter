// Backfill menu_items.price_vnd from menu_items.price, in small batches,
// while the service keeps serving traffic.
//
//   node scripts/backfill.js                 # fill every row that is still NULL
//   node scripts/backfill.js --batch=500     # rows per short transaction
//   node scripts/backfill.js --delay=25      # ms to breathe between batches
//   node scripts/backfill.js --reset         # undo the data step: price_vnd -> NULL
//                                            # (refused if any row has price_vnd but
//                                            #  no price — that value would be lost)
//
// Properties that matter for IA#2:
//   * each batch is ONE short transaction (BEGIN IMMEDIATE ... COMMIT), so a
//     writer waiting behind us is never blocked for more than a few milliseconds;
//   * the batch is selected by "price_vnd is missing or disagrees with price,
//     and price is not NULL", so the script is idempotent: stop it (Ctrl+C,
//     crash) and start it again, it picks up exactly where it stopped and
//     produces the same result. It stops only when a batch selects no rows,
//     never on a count taken at start-up, because a version still serving can
//     insert rows while it runs;
//   * the same work set repairs rows left stale by the S2 rolling window, where
//     an instance still running v1 wrote `price` alone onto a row v2 had
//     already dual-written;
//   * the precondition of this step — no running version writes `price` alone —
//     is guaranteed by the deploy (both instances are on v2 before it runs).
//     The script only offers a secondary signal: rows created during the run
//     (id above the max id seen at start) that came out NULL can only come from
//     a version that writes `price` alone, and it exits 3. That check cannot
//     see a v1 *update*, so it is not a substitute for the deploy order.
//
// Precondition (criterion 3): no running version writes `price` alone. In practice:
// v2 is on both instances, and this script is run AFTER the rolling deploy.
//
// Run `npm run check` right after it; it must print CONSISTENT.
import { setTimeout as sleep } from 'node:timers/promises';
import { open, DB_PATH } from '../src/db.js';

const opts = { batch: 500, delay: 25, reset: false };
for (const a of process.argv.slice(2)) {
  if (a === '--reset') opts.reset = true;
  else if (a.startsWith('--batch=')) opts.batch = Math.max(1, Number(a.slice(8)) || 500);
  else if (a.startsWith('--delay=')) opts.delay = Math.max(0, Number(a.slice(8)) || 0);
  else {
    console.error(`unknown argument ${a}\nusage: node scripts/backfill.js [--reset] [--batch=N] [--delay=ms]`);
    process.exit(64);
  }
}

const db = open();
const cols = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
const count = (sql, ...p) => db.prepare(sql).get(...p).n;

if (!cols.has('price_vnd')) {
  console.error('menu_items.price_vnd does not exist — apply 002_add_price_vnd first (npm run migrate).');
  process.exit(2);
}
if (!cols.has('price')) {
  console.error('menu_items.price is gone — there is nothing left to backfill from.');
  console.error('This is the point of no return: the drop of `price` (003_drop_price) cannot be undone under traffic.');
  process.exit(2);
}

// --reset only makes sense while `price` is the column every writer still fills.
// A row whose price is NULL and whose price_vnd is set was written by a version
// that only knows the new column (v4): blanking it would destroy the only value
// that row has. Refuse instead of doing that.
if (opts.reset) {
  const onlyVnd = db.prepare('SELECT count(*) n FROM menu_items WHERE price IS NULL AND price_vnd IS NOT NULL').get().n;
  if (onlyVnd > 0) {
    console.error(`refusing --reset: ${onlyVnd} rows have price_vnd but no price.`);
    console.error('They were written by a version that no longer writes `price`; resetting would lose them.');
    console.error('Roll the code back to v2 (which writes both columns) and re-run the backfill instead.');
    process.exit(2);
  }
}

// The set of rows still to do, in both directions. Both are re-runnable.
// Fill mode repairs as well as fills: a row counts as work when price_vnd is
// missing OR when it disagrees with `price`. Disagreement is not hypothetical —
// during the rolling v1 -> v2 deploy one instance writes `price` alone, so a
// row that v2 already dual-wrote can be re-priced by v1 and left with a stale
// price_vnd. The fill pass is what makes both columns agree again.
const SQL_MISSING = '(price_vnd IS NULL OR CAST(round(price * 1000) AS INTEGER) <> price_vnd)';
const SQL_TODO_FILL = `SELECT id FROM menu_items WHERE ${SQL_MISSING} AND price IS NOT NULL ORDER BY id LIMIT ?`;
const SQL_TODO_RESET = 'SELECT id FROM menu_items WHERE price_vnd IS NOT NULL ORDER BY id LIMIT ?';
const SQL_DO_FILL = 'UPDATE menu_items SET price_vnd = CAST(round(price * 1000) AS INTEGER) WHERE id IN (';
const SQL_DO_RESET = 'UPDATE menu_items SET price_vnd = NULL WHERE id IN (';
const SQL_PENDING_FILL = `SELECT count(*) n FROM menu_items WHERE ${SQL_MISSING} AND price IS NOT NULL`;
const SQL_PENDING_RESET = 'SELECT count(*) n FROM menu_items WHERE price_vnd IS NOT NULL';

const pendingSql = opts.reset ? SQL_PENDING_RESET : SQL_PENDING_FILL;
const todoSql = opts.reset ? SQL_TODO_RESET : SQL_TODO_FILL;
const doSql = opts.reset ? SQL_DO_RESET : SQL_DO_FILL;

const total = count('SELECT count(*) n FROM menu_items');
const maxIdBefore = db.prepare('SELECT max(id) m FROM menu_items').get().m ?? 0;
let left = count(pendingSql);
const filled = count('SELECT count(*) n FROM menu_items WHERE price_vnd IS NOT NULL');

console.log(`backfill ${opts.reset ? 'reset' : 'fill'} · db ${DB_PATH}`);
console.log(`rows ${total} · price_vnd set ${filled} · to do ${left} · batch ${opts.batch} · delay ${opts.delay}ms`);

if (!opts.reset) {
  const orphans = count('SELECT count(*) n FROM menu_items WHERE price IS NULL');
  if (orphans > 0) {
    const ids = db.prepare('SELECT id FROM menu_items WHERE price IS NULL ORDER BY id LIMIT 10').all().map((r) => r.id);
    console.log(`WARNING: ${orphans} rows have no price at all and cannot be derived (ids ${ids.join(', ')}${orphans > 10 ? ', ...' : ''})`);
    console.log('         fix them by hand before the drop step, or they block 003_drop_price forever.');
  }
}

let stop = false;
const askStop = () => {
  if (stop) { console.log('\nsecond signal — leaving now, the current batch may be rolled back'); process.exit(130); }
  console.log('\nSIGINT/SIGTERM — finishing the current batch, then stopping. Run the same command to continue.');
  stop = true;
};
process.on('SIGINT', askStop);
process.on('SIGTERM', askStop);

const t0 = Date.now();
let batches = 0;
let done = 0;
while (!stop) {
  // One short write transaction per batch. BEGIN IMMEDIATE takes the write lock
  // up front and waits for it (busy_timeout in src/db.js), so a concurrent
  // writer is never left in a half-deadlock.
  db.exec('BEGIN IMMEDIATE');
  let ids;
  try {
    ids = db.prepare(todoSql).all(opts.batch).map((r) => r.id);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(doSql + placeholders + ')').run(...ids);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (!ids.length) break;

  batches++;
  done += ids.length;
  // Re-count each round instead of trusting the opening total: a version still
  // serving can keep inserting rows, and the loop must not stop on a stale
  // count while those rows are still NULL.
  left = count(pendingSql);
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`batch ${String(batches).padStart(3)} · ${String(ids.length).padStart(3)} rows · ${String(left).padStart(6)} left · ${s}s`);
  if (opts.delay) await sleep(opts.delay);
}

// Verification, not decoration: this is what check.js will ask for.
const remaining = count(pendingSql);
const disagree = count('SELECT count(*) n FROM menu_items WHERE price_vnd IS NOT NULL AND price IS NOT NULL AND price_vnd <> CAST(round(price * 1000) AS INTEGER)');
const notInteger = count("SELECT count(*) n FROM menu_items WHERE price_vnd IS NOT NULL AND typeof(price_vnd) <> 'integer'");
const newNulls = opts.reset ? 0 : count('SELECT count(*) n FROM menu_items WHERE price_vnd IS NULL AND id > ?', maxIdBefore);
const orphans = opts.reset ? 0 : count('SELECT count(*) n FROM menu_items WHERE price IS NULL AND price_vnd IS NULL');

console.log(`\ndone ${done} rows in ${batches} batches · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`remaining ${remaining} · disagree ${disagree} · not_integer ${notInteger} · orphans ${orphans}`);

let code = 0;
if (newNulls > 0) {
  console.log(`FAIL ${newNulls} rows created during this run still have no price_vnd.`);
  console.log('     A version that writes `price` alone is still serving. Roll the last v1 instance');
  console.log('     out to v2, then run this script again (it is resumable).');
  code = 3;
} else if (stop && remaining > 0) {
  console.log(`STOPPED after ${batches} batches, ${remaining} rows still to do.`);
  console.log('     Run the same command again; the work set is still "missing or disagreeing".');
  code = 0;
} else if (remaining > 0) {
  console.log(`FAIL ${remaining} rows still to do.`);
  if (orphans > 0) console.log(`     ${orphans} of them have no price at all (price IS NULL) and cannot be derived; fix them by hand.`);
  else console.log('     Run again, or check for a writer that is not filling the new column.');
  code = 3;
} else if (orphans > 0) {
  console.log(`FAIL ${orphans} rows have neither price nor price_vnd — 003_drop_price will never pass while they exist.`);
  code = 3;
} else if (disagree > 0 || notInteger > 0) {
  console.log('FAIL data does not agree — do not let anything read price_vnd.');
  code = 4;
} else {
  console.log('OK — now run `npm run check`, it must print CONSISTENT.');
}
process.exit(code);
