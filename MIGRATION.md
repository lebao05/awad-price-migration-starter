# MIGRATION.md — `menu_items.price` (thousands, REAL) → `menu_items.price_vnd` (dong, INTEGER)

The menu service of `smart-restaurant`, two instances, one SQLite file. The column
being replaced holds **thousands of dong as a float** (`45.5` = 45,500 đ). The new
column holds **dong as an integer** (`45500`). `price` has to disappear at the end
without one failed request, and every step until the drop has to be reversible.

The HTTP contract never changes: old clients keep sending and reading `price`
(thousands) for the whole semester; new clients send and read `priceVnd` (dong)
from the moment the API offers it. `order_items.unit_price` keeps its old unit
and is not touched.

## The versions

| Tag | Shape of the code | Reads | Writes | API |
|---|---|---|---|---|
| `v1` | the starter (service code unchanged; only a Windows path fix in `scripts/migrate.js`) | `price` | `price` | `price` |
| `v2` | expand + dual write | `price`; derives `priceVnd` from `price` when `price_vnd` is still NULL | `price` **and** `price_vnd` | `price` + `priceVnd` |
| `v3` | first version that reads the new column | `price_vnd`, falling back to `price` when it is NULL | `price` **and** `price_vnd` | `price` + `priceVnd` |
| `v4` | contract | `price_vnd` only | `price_vnd` only | `price` (derived = `price_vnd / 1000`) + `priceVnd` |

`v2` and `v3` are separated on purpose: `v2` writes both columns, so rolling `v3`
back to it keeps every column in sync. `v4` is the first version whose SQL does
not mention `price` at all, which is what makes the drop safe.

## The plan

One row per step. "Undo" is the exact command that returns the system to the
previous row. "Earlier versions safe" means: that version can still serve next
to the current code without returning a wrong price (it is a data-compatibility
statement, not only a schema statement).

| # | Step | Schema after the step | Code on every instance | Undo command | Earlier versions still safe |
|---|---|---|---|---|---|
| S0 | baseline | `001_init`: `menu_items(id, name, price REAL NULL)` | `v1` on `:3001` and `:3002` | `npm run migrate:down` → `001_init.down.sql` (only meaningful on a scratch DB) | — none |
| S1 | **expand** | `001 + 002_add_price_vnd`: adds `price_vnd INTEGER NULL`; no data written | still `v1` on both | `npm run migrate:down` → `002_add_price_vnd.down.sql` (`DROP COLUMN price_vnd`) | `v1` ✓ — it never names the new column |
| S2 | **dual write** | unchanged | `v2` on both, rolling: `:3001` first, then `:3002` | roll `v2` back out to `v1` one instance at a time — `U2` | `v1` ✓ — `v2` serves `price`, the column `v1` writes; a `v1` write in the rolling window can leave `price_vnd` stale on a row `v2` already dual-wrote, and S4 repairs that. `v2` ✓ |
| S3 | **new clients on** — the one traffic run starts here (criterion 4) | unchanged | `v2` on both | stop the traffic run and start it again with `NEW_CLIENTS=0` — `U3`, a traffic-side switch, nothing in the database | `v2` ✓; `v1` ✗ — it has no `priceVnd` in the response, so a new client gets a broken contract |
| S4 | **backfill** | unchanged; `price_vnd` filled for every row, and repaired where a `v1` write left it disagreeing with `price` | `v2` on both | `node scripts/backfill.js --reset` — `U4` — sets `price_vnd` back to NULL in batches. Valid only while a version that also writes `price` (`v2` or `v3`) is serving, i.e. before S6 | `v2` ✓; `v1` ✗ — a v1 write after the backfill leaves a row with no `price_vnd`, and the backfill has already run |
| S5a | **read the new column** | unchanged (both columns, both full) | `v3` on both, rolling: `:3001` first, then `:3002` | roll `v3` back to `v2` one instance at a time — `U5` | `v2` ✓ (both keep both columns in sync), `v3` ✓; `v1` ✗ — it writes `price` only, so `v3` reads a stale `price_vnd` |
| S5b | **roll back to `v2`**, under traffic (criterion 5) | unchanged | `v2` on both, rolling back `:3002` first, then `:3001` | deploy `v3` again, i.e. re-run the rolling restart of S5a — `U5` with `..\v3` | `v2` ✓; `v1` ✗ (same reason as S5a) |
| S5c | **roll forward to `v3` again** | unchanged | `v3` on both, rolling: `:3001` first, then `:3002` | roll back to `v2` again — `U5` | `v2` ✓; `v3` ✓ |
| S6 | **contract code** | unchanged; `price` still exists but no running version reads or writes it | `v4` on both, rolling: `:3001` first, then `:3002` | roll `v4` back to `v3` one instance at a time — `U6` | `v3` ✓ (reads `price_vnd`; its writes of `price` are harmless); `v2` ✗ and `v1` ✗ — both read `price`, which `v4` no longer updates |
| S7 | **drop `price`** — point of no return | `003_drop_price`: `menu_items(id, name, price_vnd INTEGER)` | `v4` on both | `npm run migrate:down` in `..\v4` — `U7` — re-adds `price` and re-derives it from `price_vnd`. **Not** a zero-downtime way back; see below | `v4` ✓; `v3` ✗ (`no such column: price` on every request), `v2` ✗, `v1` ✗ |
| S8 | **rehearsal of every `.down.sql`** (criterion 2) | a separate file, `data/scratch.db`, stepped through the same schema states | nothing — the live instances are untouched | re-apply with `npm run migrate`, or delete the scratch file | n/a — a different database file |

S5 is split into S5a/S5b/S5c so that the plan itself shows criterion 5: `v3`
goes out, comes back to `v2` **under traffic**, then goes out again, with
`npm run check` printing `CONSISTENT` before and after. S8 is not a deploy: it
exists because criterion 2 asks for `migrate:down` to have been run once for
every migration, and its output belongs in `check-log.txt`.

**Why traffic starts at S3 and not at S0.** `scripts/traffic.js` reads
`NEW_CLIENTS` **once, at start-up**, and keeps that share for the whole process;
it has no runtime switch. `v1` does not answer `priceVnd` at all, so a run that
starts with new clients on while `v1` still serves would count every new-client
request as a contract failure — thousands of them. A run that starts with new
clients off can never turn them on. The only zero-failure single-process
configuration is therefore: **one process, `NEW_CLIENTS=0.3`, started at the
step where the API first offers `priceVnd`** — the moment `v2` is on both
instances (S3). Everything before it (S0..S2) is schema work and a rolling
restart whose evidence is `check-log.txt`; from S3 to after S7 the same process
covers every deploy, every rolling restart, the rollback and the drop, and ends
with `RESULT: zero failed requests`. The two halves of criterion 4 are in
tension here, and this is the reading that keeps the log continuous.

`v2` derives `priceVnd` from `price` when `price_vnd` is still NULL, which is
why new clients are safe at S3 even though the backfill (S4) has not run yet.

`npm run migrate` applies the pending `NNN_*.up.sql` files in order, one
transaction each; `npm run migrate:down` reverts the **last** applied step.

### The exact undo commands `U1`–`U7` (PowerShell)

`U2`, `U5` and `U6` are the same rolling restart with a different worktree.
One instance at a time; the other instance keeps serving, and the traffic log
shows a `down` line and a `back` line for the port that restarted:

```powershell
# run once per port, 3001 first and then 3002, from a second terminal
$dir = '..\v2'; $port = 3001
Stop-Process -Id (Get-NetTCPConnection -LocalPort $port -State Listen).OwningProcess -Force
cd $dir
$env:PORT = $port
$env:DB_PATH = 'D:\advanced_web\IA2\awad-price-migration-starter\data\app.db'
node src/server.js
```

| # | What it does | Exact command |
|---|---|---|
| `U1` | undo S1 (drop `price_vnd`) | `cd ..\v2` then `npm run migrate:down` |
| `U2` | undo S2: `v2` → `v1` | the block above with `$dir = '..\v1'` |
| `U3` | undo S3 (new clients off) | Ctrl+C the traffic run, then `$env:NEW_CLIENTS = 0; npm run traffic` — traffic-side only, nothing in the database. It is the one undo that costs the single-run property of the log, which is why it is not part of the recorded run |
| `U4` | undo S4 (empty the new column) | `cd ..\v2` then `node scripts/backfill.js --reset` |
| `U5` | undo S5a/S5c: `v3` → `v2` | the block above with `$dir = '..\v2'` |
| `U6` | undo S6: `v4` → `v3` | the block above with `$dir = '..\v3'` |
| `U7` | undo S7 (bring `price` back) | `cd ..\v4` then `npm run migrate:down` (see the caveat below) |

Each of these returns the system to the row above it. `U1` and `U7` need the
code step above them undone first, because `migrate:down` reverts the last
applied migration and the running code must not be a version that reads the
column being removed.

### Rehearsing every `.down.sql` (criterion 2)

On a scratch file, so the live database is never touched, and with the output
labelled in `check-log.txt`:

```powershell
cd D:\advanced_web\IA2\awad-price-migration-starter
$env:DB_PATH = 'D:\advanced_web\IA2\awad-price-migration-starter\data\scratch.db'
Remove-Item data\scratch.db* -ErrorAction SilentlyContinue
npm run migrate           # 001, 002, 003
npm run migrate:down      # reverts 003_drop_price
npm run migrate:down      # reverts 002_add_price_vnd
npm run migrate:down      # reverts 001_init
npm run migrate:status    # every step now unchecked
```

Both other directions are exercised by the live run itself: S1 is
`002_add_price_vnd.up.sql`, S7 is `003_drop_price.up.sql`, and S0 is
`001_init.up.sql`.

**Which directory a command runs from.** A migration travels with the version
that can tolerate it, and `npm run migrate` applies *every* pending file, so the
tree must not contain a step that is not due yet:

- `003_drop_price` is committed together with `v4`, so at S1..S6 it simply is
  not in the worktree and `npm run migrate` cannot apply it by accident.
- S1 is run from the `v2` worktree (`..\v2`), while the servers still run
  `..\v1`; adding a column does not require the running code to know about it.
- S7 is run from the `v4` worktree, after both instances are `v4`.

That is also why each tag's migration set matches its row: `v1` has `001`,
`v2` has `001+002`, `v4` owns `003`, and `v3` changes code only.

### Repository state this plan assumes

The table above only grades well if the repository actually looks like this, so
these are part of the work, not incidental:

- tags `v1`, `v2`, `v3`, `v4` exist and each one is the code that was deployed
  at that step;
- `002_add_price_vnd.*` is committed **in `v2`**, and `003_drop_price.*` only in
  `v4` — nothing else may carry `003`, or `npm run migrate` in `v2`/`v3` will
  drop `price` in the middle of the plan;
- `scripts/backfill.js` is present from `v1` on (it was committed with the
  pre-deploy housekeeping), but it refuses to run until `002_add_price_vnd` is
  applied — it exits 2 when `price_vnd` does not exist — so the version that
  actually uses it is `v2`;
- the `v1` worktree contains `migrations/001_*` **only**: `test/app.test.js`
  applies every `*.up.sql` it finds in that directory, so a stray
  `003_drop_price` in the `v1` tree makes `npm test` fail before any deploy;
- `MIGRATION.md` is part of `v4`; `traffic-log.txt` and `check-log.txt` are the
  evidence commit on `main` immediately after the `v4` tag, produced by the run
  the plan describes.


## The point of no return: S7, dropping `price`

S7 is the point of no return, and it is the only one.

- **What breaks backwards.** `v3` and everything older select `price` in their
  prepared statements. After the drop, every request that reaches them fails
  with `no such column: price`; there is no version of `v1`..`v3` that can serve
  this schema at all.
- **Why the `.down.sql` is not a way back.** The down file exists and does the
  mechanical inverse (`ADD COLUMN price REAL` + `UPDATE … SET price =
  price_vnd / 1000.0`) in one transaction, and running it under `v4` traffic
  does not break `v4`, because `v4` never names `price`. What it produces,
  though, is a column **nothing maintains**: from the moment the transaction
  commits, every `v4` write updates only `price_vnd`, so `price` starts going
  stale. Handing the database back to `v2` or `v3` therefore needs two things
  that cannot happen while serving: every `v4` instance must stop first (no
  older version can serve this schema before the down has run, and none of them
  can serve it afterwards without the column being kept in sync), and the whole
  table has to be re-derived again. That is a stop, so it is not a way back
  under this assignment's rule.
- **What is already lost.** Every price written after S7 exists only in
  `price_vnd`; `price` is not "empty", it is nonexistent. So the revert is a
  restore from the new source of truth, not an undo of the write.

Before S7 every earlier step is reversible without stopping traffic, which
is the promise the rubric asks for: a way back at every step *until the one you
name*.

## Why the rollback at S5b is safe, and which rollback would not be

At S5b, `:3001` still runs `v3` while `:3002` has already gone back to `v2`, and
then the same for `:3001`: that is the rollback, under traffic. S5c then puts
`v3` back on both instances, so the criterion is satisfied in both directions
with `CONSISTENT` before and after.

It is safe because **both `v2` and `v3` write both columns on every write path**.
Whichever instance takes a write, the other column is updated in the same
statement batch, so:

- a read that lands on `v2` (reads `price`) sees a value that `v3` just wrote;
- a read that lands on `v3` (reads `price_vnd`, falls back to `price`) sees a
  value that `v2` just wrote;
- `npm run check` prints `CONSISTENT` before and after, because `price_vnd =
  round(price * 1000)` still holds for every row.

The rollback that would **not** be safe is any rollback past S6/S7:

- `v4` → `v3` is still safe before the drop, because `price` still exists and
  `v3` prefers `price_vnd`.
- `v4` → `v2` is **not** safe, even before the drop: `v2` reads `price`, which
  `v4` never writes, so every re-priced row would be served to old clients at
  its old price. `traffic` counts that as `stale`.
- After S7 nothing older than `v4` runs at all — that is the point of no return.

Rule of thumb used throughout: **two versions may share the database when every
write of either one preserves the values the other one's readers and API need.**
That is not the same as "the same write set":

- `v1` (writes `price`) + `v2` (writes both) is safe at S2 because `v2` reads
  `price`. One window needs care: while the rolling restart is half done, one
  instance is still `v1`, so a `v1` write can land on a row that `v2` had
  already dual-written and leave `price_vnd` **stale** relative to `price`. In
  this plan the window is empty, because the single traffic run starts only
  after both instances are `v2` (S3); if traffic were running there, old clients
  would still be served correctly (`v2` reads `price`), and the backfill at S4
  repairs every such row, because its work set includes disagreements and not
  only NULLs — that is why the check right after the backfill is `CONSISTENT`
  and not "consistent except for the rows the deploy touched".
- `v3` + `v4` is safe at S6 because `v3` reads `price_vnd`, and `v4` keeps
  `price_vnd` up to date; `v3`'s extra write of `price` harms nobody, since no
  running version reads it.
- `v4` + `v2` is **not** safe: `v2` reads `price`, and `v4` stops writing it.
- `v3` + `v1` is **not** safe: `v3` reads `price_vnd` first, and `v1` changes
  only `price`.

## Conversion and precision

- `price_vnd = CAST(round(price * 1000) AS INTEGER)` — one rounding step, to the
  nearest dong.
- `price = price_vnd / 1000.0` — the derived value `v4` returns to old clients.
- Any price with at most three decimals (`45.551` = 45,551 đ) survives the round
  trip `price → price_vnd → price` exactly. The starter's `isPrice` accepts any
  finite number in `(0, 100000]`, so a value with more decimals *would* be
  rounded to the nearest dong and come back slightly different. That is
  deliberate: the target unit has no sub-dong precision, and silently keeping a
  float would defeat the point of the migration. It is called out here so it is
  not a surprise. In practice it cannot be observed: `seed.js` and `traffic.js`
  both build prices as `n / 2`, i.e. half-thousand steps, which are exact in
  IEEE-754.
- `price` is nullable in the starter ("a half-done cleanup"). The backfill
  cannot derive a dong value from NULL. `scripts/backfill.js` lists those ids
  and exits non-zero instead of guessing; `scripts/check.js` prints
  `CONSISTENT, but N rows have no price_vnd yet — nothing may read price_vnd
  until they do` (it still exits 0) so the warning cannot be mistaken for a
  clean state after S4. The current database has no such row.

## Ordering rules this plan depends on

1. **Expand before code** (S1 before S2): `v2` writes `price_vnd`, so the
   column must exist first. Applied while `v1` is still serving — `v1` ignores
   it, so nothing breaks.
2. **Backfill only after the last `v1` is gone** (S4 after S2): the backfill
   must not race a version that writes `price` alone. That order is guaranteed
   by the deploy — both instances run `v2` before the script starts — and not by
   the script. The script only offers a secondary signal: rows created during
   the run (id above the max id seen at start) that came out NULL mean a
   `price`-only writer is still serving, and it exits with code 3 telling you to
   finish the deploy and run it again. That check cannot see a v1 *update* of an
   existing row, so it is not a substitute for the deploy order. The script is
   idempotent and resumable — its work set is "`price_vnd` missing **or**
   disagreeing with `price`, and `price` is not NULL".
3. **New clients only after `v2` is everywhere** (S3 after S2): before that, a
   new-client request that lands on `v1` gets no `priceVnd`.
4. **Drop only after `v4` is everywhere** (S7 after S6): `v4` neither reads nor
   writes `price`, so it does not care that the column disappears; `v3` does.

## Under traffic, and the backfill's shape

The backfill runs while both instances serve:

- batches of 500 rows, `--batch=500`, with a pause between batches
  (`--delay=25`) so writers always get the lock;
- each batch is one `BEGIN IMMEDIATE … COMMIT`, so the longest write lock is a
  few milliseconds — far below the 5 s `busy_timeout`;
- no external progress file: the next batch is selected by "still missing or
  still disagreeing", so Ctrl+C, a crash, or a second run all produce the same
  result;
- it refuses to run if `price_vnd` is missing (S1 not applied) or if `price`
  is already gone (S7);
- `--reset` refuses to blank a row whose only price is `price_vnd`, so the undo
  of S4 cannot destroy a value written by `v4`.

`traffic-log.txt` and `check-log.txt` in this repository are the evidence:
**one** traffic process, started at S3 and never restarted, running through the
backfill, `v3`, the rollback to `v2`, the roll-forward, `v4` and the drop, with
the `down` / `back` lines of every rolling restart in it and `RESULT: zero
failed requests` at the end; plus one labelled `npm run check` per step, with
`CONSISTENT` right after the backfill.

Exact commands for the recorded run:

```powershell
# S0..S2 are done with no traffic: fresh database, 002, rolling v1 -> v2
$env:NEW_CLIENTS = 0.3; npm run traffic     # S3: the one and only traffic process
# S4 backfill, S5a/S5b/S5c, S6, S7 all happen under this same process
```

The run is started after the `v2` rollout because `traffic.js` fixes the
new-client share at start-up and `v1` cannot answer `priceVnd`; starting it
earlier with new clients on would produce contract failures, and starting it
earlier with them off would mean they are never on. The consequence is stated
plainly: the `v1` → `v2` rolling restart is the one deploy that is not inside
`traffic-log.txt` — its evidence is `check-log.txt` (S0..S2) and the worktree /
tag history. Everything from S3 on is in the single continuous run.

## What `npm run check` means at each step

`check-log.txt` has one labelled run after every step. Three outputs are worth
reading carefully:

- **S1 and S2 print `CONSISTENT, but N rows have no price_vnd yet`.** That is
  the truth after the expand and during the dual-write phase: the column exists
  and is empty, so nothing may read it, and S4 is what fills it. From S4 on,
  `price_vnd_null` is 0.
- **S6 prints `INCONSISTENT`.** This is not lost data. From S6 on `v4` no longer
  writes `price`, so `price` starts to go stale the moment a `v4` instance takes
  a write, and `scripts/check.js` — the starter's script, unmodified — counts
  every row where the two columns have drifted apart as `disagree`. What it
  reports is the old column being abandoned, which is the point of the step;
  `price_vnd`, the column that is about to be the only one, is complete and
  integral in that same output. After S7 the old column is gone and the same
  script prints `CONSISTENT` again. The check criterion 3 asks about is the one
  right after the backfill, and that one is `CONSISTENT`.
- **S2 in this recording has nothing to disagree about**, because the `v1` →
  `v2` rolling restart happens before traffic starts, so no `v1` write can land
  after a `v2` dual-write. Had traffic been running, a few rows could have been
  left with a stale `price_vnd`, and the backfill at S4 repairs those as well as
  the NULLs.

## SQLite here, PostgreSQL in the exam

Nothing in this plan relies on SQLite-only tricks, but three things change in
PostgreSQL and are worth stating:

- `ALTER TABLE … ADD COLUMN` without a default is metadata-only in SQLite; in
  PostgreSQL it takes a short `ACCESS EXCLUSIVE` lock, so it must not queue
  behind a long transaction.
- `DROP COLUMN` in PostgreSQL also needs `ACCESS EXCLUSIVE`; that is why the
  drop is the dangerous step there too — it waits for every open transaction
  before it can take the lock, and a single long reader stalls the whole queue
  behind it.
- The backfill must stay batched with a commit per batch, and `id`-ordered, to
  avoid one huge transaction that would itself hold the locks the deploy needs.
