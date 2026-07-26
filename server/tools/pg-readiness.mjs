#!/usr/bin/env node
/**
 * PostgreSQL readiness audit — the first concrete step of a SQLite → Postgres
 * migration. It scans the server source and reports every construct that would
 * NOT port as-is, grouped by category, with counts, file:line samples, and the
 * Postgres equivalent. Nothing is changed; this just turns "we should move to
 * Postgres someday" into a scoped, fact-based work list.
 *
 *   node tools/pg-readiness.mjs            # full report
 *   node tools/pg-readiness.mjs --samples 3
 *
 * Run from the server/ directory (or anywhere — it resolves src/ relative to
 * this file).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const SAMPLES = Number(process.argv[process.argv.indexOf('--samples') + 1]) || 4;

// Every category is one class of SQLite-specific behaviour, its Postgres
// equivalent, and a regex that finds it. `blocking` marks the ones that make a
// query fail outright (vs. the pervasive-but-mechanical async conversion).
const CATEGORIES = [
  {
    key: 'sync-calls', title: 'Synchronous query calls (.get/.all/.run/.pluck)',
    re: /\.(get|all|run|pluck)\s*\(/g, blocking: true,
    fix: 'better-sqlite3 is synchronous; node-postgres is async. Each becomes `await`, and its function becomes async. This is the dominant cost — see the plan for the recommended seam (a thin promise-returning db wrapper) so handlers change in one predictable way.',
  },
  {
    key: 'now', title: "datetime('now') / date('now')",
    re: /\b(datetime|date)\s*\(\s*'now'/g, blocking: true,
    fix: "Postgres: now() (timestamptz) or current_date. For the app's UTC 'YYYY-MM-DD HH:MM:SS' text, use to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS').",
  },
  {
    key: 'strftime', title: 'strftime() / julianday() date math',
    re: /\b(strftime|julianday)\s*\(/g, blocking: true,
    fix: "Postgres: to_char()/date_trunc()/extract(). Day differences via (a::date - b::date); epoch via extract(epoch from a-b). These need per-query translation — the trickiest bucket.",
  },
  {
    key: 'autoincrement', title: 'AUTOINCREMENT primary keys',
    re: /\bAUTOINCREMENT\b/g, blocking: true,
    fix: 'Postgres: `GENERATED ALWAYS AS IDENTITY` (or serial). Applies at schema-creation time only, not in queries.',
  },
  {
    key: 'upsert', title: 'INSERT OR IGNORE / INSERT OR REPLACE',
    re: /\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/gi, blocking: true,
    fix: 'Postgres: `INSERT ... ON CONFLICT (cols) DO NOTHING` (ignore) or `DO UPDATE SET ...` (replace). Needs the conflict target named explicitly.',
  },
  {
    key: 'pragma', title: 'PRAGMA statements',
    re: /\bPRAGMA\b/g, blocking: true,
    fix: 'SQLite-only. Drop, or replace with the Postgres equivalent (e.g. integrity_check → pg native checks / pg_dump verification).',
  },
  {
    key: 'boolean', title: 'Boolean-as-integer (= 0 / = 1 filters, 0/1 writes)',
    re: /=\s*[01]\b|\b(is_|has_|active|completed|approved|deleted|archived)\w*\s*=\s*[01]/g, blocking: false,
    fix: "Postgres has a real boolean type. Either keep integer columns (smallint) so 0/1 keeps working, or move to boolean and change comparisons to TRUE/FALSE. Keeping smallint is the lower-risk first pass. (Heuristic match — review hits.)",
  },
  {
    key: 'backup', title: 'better-sqlite3 online backup (db.backup)',
    re: /\bdb\.backup\s*\(/g, blocking: true,
    fix: 'Postgres: pg_dump (logical) or physical/base backups + WAL archiving. The whole backup module is re-implemented around pg_dump; the off-site/verify scaffolding built earlier carries over.',
  },
  {
    key: 'transaction', title: 'better-sqlite3 transactions (.transaction)',
    re: /\.transaction\s*\(/g, blocking: true,
    fix: 'node-postgres: acquire a client, BEGIN / COMMIT / ROLLBACK around awaited queries. Each of these becomes an async transaction block.',
  },
  {
    key: 'insert-rowid', title: 'lastInsertRowid usage',
    re: /lastInsertRowid/g, blocking: true,
    fix: "Postgres has no lastInsertRowid. Use `INSERT ... RETURNING id` and read the returned row.",
  },
];

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const rel = (p) => path.relative(path.join(__dirname, '..'), p);

let grandTotal = 0;
const results = CATEGORIES.map((cat) => {
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      cat.re.lastIndex = 0;
      const m = cat.re.exec(line);
      if (m) hits.push({ file: rel(file), line: i + 1, text: line.trim().slice(0, 100) });
    });
  }
  grandTotal += hits.length;
  return { cat, hits };
});

const C = { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', reset: '\x1b[0m' };
console.log(`\n${C.bold}PostgreSQL readiness audit${C.reset} — ${files.length} source files scanned\n`);
console.log(`${C.dim}Each row is a class of SQLite-specific behaviour to port. "blocking" = a query`);
console.log(`fails without the change; the rest are mechanical or schema-time.${C.reset}\n`);

for (const { cat, hits } of results) {
  const tag = cat.blocking ? `${C.red}blocking${C.reset}` : `${C.yellow}review ${C.reset}`;
  const n = String(hits.length).padStart(4);
  console.log(`${C.bold}${n}${C.reset}  [${tag}]  ${cat.title}`);
  console.log(`      ${C.dim}→ ${cat.fix}${C.reset}`);
  for (const h of hits.slice(0, SAMPLES)) {
    console.log(`      ${C.dim}${h.file}:${h.line}${C.reset}  ${h.text}`);
  }
  if (hits.length > SAMPLES) console.log(`      ${C.dim}… and ${hits.length - SAMPLES} more${C.reset}`);
  console.log('');
}

const blocking = results.filter((r) => r.cat.blocking).reduce((s, r) => s + r.hits.length, 0);
console.log(`${C.bold}Totals${C.reset}: ${grandTotal} occurrences across ${files.length} files ` +
  `(${C.red}${blocking} blocking${C.reset}).`);
console.log(`${C.dim}The sync-call count is the migration's true size: every one becomes async.`);
console.log(`See docs/POSTGRES-MIGRATION.md for the staged plan and recommended seam.${C.reset}\n`);

// Machine-readable summary for CI / progress tracking.
if (process.argv.includes('--json')) {
  const summary = Object.fromEntries(results.map((r) => [r.cat.key, r.hits.length]));
  console.log(JSON.stringify({ files: files.length, total: grandTotal, blocking, byCategory: summary }, null, 2));
}
