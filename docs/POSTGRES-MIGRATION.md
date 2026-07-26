# SQLite → PostgreSQL migration plan

**Status:** planning / groundwork. No application code has moved yet.
**Trigger to actually execute:** write concurrency (not data size) becoming the
bottleneck — roughly _hundreds of concurrent active users_, or a need for
multiple app instances / high availability. TeamHub is comfortably below that
today, so this is a map, not a to-do.

Run the readiness audit any time to see the current scope, grounded in the real
source:

```bash
cd server && node tools/pg-readiness.mjs            # human report
node tools/pg-readiness.mjs --json                  # machine summary
```

---

## The honest scope

The growth-roadmap card said "swap the driver, port the SQLite-isms." That
undersells one thing: **`better-sqlite3` is synchronous and `node-postgres`
(`pg`) is asynchronous.** Today every route handler calls the database inline
(`const rows = db.prepare(sql).all(...)`) with no `await`. Moving to `pg` means
every one of those becomes `await`, and every function up the call chain becomes
`async`.

Latest audit (`node tools/pg-readiness.mjs`):

| Category | Count | Nature |
|---|---:|---|
| Synchronous query calls (`.get/.all/.run/.pluck`) | ~894 | **The real cost** — each becomes `await` |
| Boolean-as-integer (`= 0` / `= 1`) | ~181 | Review; can keep as `smallint` to avoid churn |
| `lastInsertRowid` | ~53 | → `INSERT ... RETURNING id` |
| `datetime('now')` / `date('now')` | ~83 | → `now()` / `current_date` |
| `INSERT OR IGNORE` / `OR REPLACE` | ~30 | → `ON CONFLICT DO NOTHING/UPDATE` |
| `AUTOINCREMENT` | ~31 | → `GENERATED AS IDENTITY` (schema only) |
| `strftime()` / `julianday()` | ~19 | → `to_char()` / date subtraction (trickiest) |
| `.transaction(...)` | ~12 | → `BEGIN/COMMIT` around awaited queries |
| `PRAGMA` | 2 | SQLite-only; drop/replace |
| `db.backup(...)` | 1 | → `pg_dump` (backup module rewrite) |

So the effort is **not** "a contained change." The bulk is mechanical (the
sync→async conversion), but it is pervasive and must be done carefully. Plan for
a focused multi-week effort with the app frozen feature-wise during cutover, not
an afternoon.

---

## Recommended strategy: a promise-returning seam first

Rather than hand-editing 894 call sites and hoping, introduce a **thin database
seam** so the conversion is uniform and reviewable:

1. **Introduce `db.get()/db.all()/db.run()` as async methods** on a small wrapper
   module, keeping the exact call shapes the code already uses. Back it with
   `better-sqlite3` at first (wrapping the sync calls in resolved promises).
   Nothing changes behaviourally, but now every call site can be converted to
   `await db.get(...)` mechanically — ideally with a codemod (jscodeshift) over
   the 31 files, not by hand.
2. **Make the handlers async.** Because Express already supports async handlers,
   this is a mechanical sweep once the seam is in place. Add an async error
   wrapper so a rejected query returns a clean 500.
3. **Swap the seam's backend to `pg`.** Only the wrapper module changes; the 894
   converted call sites don't. This is where the SQL-dialect fixes below land,
   behind the same interface.

This ordering means step 1–2 ship and run on SQLite (fully testable, zero
behaviour change), and only step 3 introduces Postgres — a much smaller, safer
diff to review and roll back.

---

## SQL dialect fixes (behind the seam)

| SQLite | PostgreSQL |
|---|---|
| `datetime('now')` | `to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')` (to keep the app's text timestamps) or move columns to `timestamptz` and use `now()` |
| `date('now')` | `current_date` |
| `strftime('%Y-%m', x)` | `to_char(x::timestamp, 'YYYY-MM')` |
| `julianday(a) - julianday(b)` | `(a::date - b::date)` for whole days, or `extract(epoch from a::timestamp - b::timestamp)/86400` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` |
| `INSERT OR IGNORE INTO t ... ` | `INSERT INTO t ... ON CONFLICT (<key cols>) DO NOTHING` |
| `INSERT OR REPLACE INTO t ...` | `INSERT INTO t ... ON CONFLICT (<key cols>) DO UPDATE SET ...` |
| `info.lastInsertRowid` | `INSERT ... RETURNING id` → read `rows[0].id` |
| `0` / `1` booleans | keep as `smallint` (least churn) **or** convert columns to `boolean` and comparisons to `TRUE/FALSE` |
| `PRAGMA table_info(t)` (used by the `ensureColumn` migration helper) | `information_schema.columns`; rewrite `ensureColumn` for Postgres |
| `db.backup(file)` | `pg_dump` (see Backups below) |

**Watch-outs**

- **Type affinity vs. strict types.** SQLite is lax; Postgres is strict. Columns
  that today hold mixed content (e.g. a number sometimes stored as text) will
  reject on insert. The data-migration pass (below) surfaces these.
- **Case-sensitive `LIKE`.** SQLite `LIKE` is case-insensitive for ASCII;
  Postgres `LIKE` is case-sensitive. Audit search queries and switch to `ILIKE`
  where the current behaviour is relied on.
- **`AUTOINCREMENT`/rowid ordering.** Anywhere the code leans on implicit rowid
  ordering, add an explicit `ORDER BY id`.

---

## Data migration

1. **Schema:** author the Postgres DDL from the current `db.js` schema (translate
   the CREATE TABLEs per the table above). Keep it in a versioned SQL file.
2. **Data copy:** for each table, `SELECT *` from SQLite and bulk-`INSERT` (or
   `COPY`) into Postgres, in FK-dependency order (workspaces → users → clients →
   tasks → …). A one-off Node script using both drivers is the simplest; run it
   against a **copy** of production, never live.
3. **Reset identity sequences** after load: `SELECT setval(pg_get_serial_sequence('t','id'), max(id)) FROM t;` for each table, so new inserts don't collide.
4. **Verify:** row counts per table match, and a sample of high-value rows
   (a workspace, its users, a task with dependencies) round-trips intact.

---

## Backups after Postgres

The backup module (`server/src/backup.js`) is SQLite-specific (`db.backup()` +
file copy). On Postgres it becomes:

- `pg_dump` (custom format) on the interval, plus the **uploads** mirror exactly
  as today.
- The **off-site sync**, **integrity/verify drill**, and **restore** scaffolding
  built in the backup-hardening PR carry over almost unchanged — only the
  snapshot mechanism swaps (`pg_dump` / `pg_restore --list` for the drill).
- For continuous protection, add **WAL archiving** (or a hosted Postgres with
  point-in-time recovery).

---

## Cutover & rollback

1. Ship the async seam (steps 1–2) on SQLite; run in production a while — no
   Postgres yet, fully reversible.
2. Stand up Postgres; run the data-migration script against a production copy;
   run the full `npm test` suite pointed at Postgres.
3. Schedule a short maintenance window: final data sync, flip the seam's backend
   env to Postgres, smoke-test, done.
4. **Rollback:** keep the SQLite file untouched through the window; if anything
   is wrong, flip the seam back to SQLite and investigate — no data lost.

---

## Honest alternatives (consider before committing)

Postgres is the right answer for real horizontal scale, but if the pressure is
narrower, cheaper options may buy years:

- **Stay on SQLite, add replication:** `litestream` streams the SQLite file to
  object storage continuously (near-zero-RPO DR) with **no code change** — this
  addresses the _durability_ half of the roadmap without the migration.
- **SQLite WAL tuning** already gives good read concurrency; the ceiling is
  concurrent _writes_. Confirm writes are actually the bottleneck (measure)
  before paying for the rewrite.
- **`rqlite` / `dqlite`:** distributed SQLite for HA while keeping SQL surface.

Recommendation: do the **litestream** durability step early (cheap, big safety
win), and hold the full Postgres migration until measured write-concurrency
demands it.

---

_Generated as the groundwork step; figures come from `server/tools/pg-readiness.mjs`
run against this repository. Re-run it to refresh the scope as the code evolves._
