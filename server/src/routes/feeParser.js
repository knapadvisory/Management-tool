// Staff-only "Fee Register Parser" tool.
// Express hands uploaded marketplace fee PDFs to the tested Python parser
// (tools/amazon_invoice_parser.py) as a child process, and returns an .xlsx
// register plus a per-document reconciliation summary. Nothing leaves the
// server; temp files are swept after a short TTL.
//
// Mounted in index.js (staff-only) as:
//   app.use('/api/tools/fee-parser', requireAuth, blockGuests, feeParserRouter);
import express from 'express';
import multer from 'multer';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();

// Config (override with env vars in deployment). Default resolves the parser at
// the repo root's tools/ folder — /app/tools in the container — from this file
// at server/src/routes/.
const PYTHON = process.env.PARSER_PYTHON || 'python3';
const PARSER = process.env.PARSER_SCRIPT || path.resolve(__dirname, '../../../tools/amazon_invoice_parser.py');

const upload = multer({
  dest: os.tmpdir(),
  limits: { files: 80, fileSize: 25 * 1024 * 1024 }, // 80 PDFs, 25 MB each
});

const JOBS = new Map(); // token -> { file, dir, expires }
const TTL = 15 * 60 * 1000;

function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

// POST /process  (multipart: files[])
router.post('/process', upload.array('files', 80), (req, res) => {
  const all = req.files || [];
  const pdfs = all.filter((f) => f.originalname.toLowerCase().endsWith('.pdf'));
  // Always clear whatever multer wrote to the OS temp dir; keep only the PDFs we move.
  const nonPdf = all.filter((f) => !f.originalname.toLowerCase().endsWith('.pdf'));
  for (const f of nonPdf) { try { fs.rmSync(f.path, { force: true }); } catch { /* ignore */ } }
  if (!pdfs.length) {
    return res.status(400).json({ error: 'No PDF files were received.' });
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'feereg-'));
  for (const f of pdfs) {
    const safe = f.originalname.replace(/[\\/:*?"<>|]/g, '_');
    try { fs.renameSync(f.path, path.join(work, safe)); }
    catch { fs.copyFileSync(f.path, path.join(work, safe)); fs.rmSync(f.path, { force: true }); }
  }
  const out = path.join(work, 'Fee_Register.xlsx');

  execFile(PYTHON, [PARSER, work, out, '--json'], { timeout: 120000 }, (err, stdout, stderr) => {
    if (err || !fs.existsSync(out)) {
      cleanup(work);
      return res.status(500).json({
        error: 'Could not process the files.',
        detail: String(stderr || err || '').slice(0, 400),
      });
    }
    const line = (stdout || '').split('\n').find((l) => l.startsWith('RECON_JSON:'));
    let payload = { version: '', rows: [] };
    if (line) { try { payload = JSON.parse(line.slice('RECON_JSON:'.length)); } catch { /* keep default */ } }

    const token = crypto.randomBytes(12).toString('hex');
    JOBS.set(token, { file: out, dir: work, expires: Date.now() + TTL, userId: req.user?.id });
    const rows = payload.rows || [];
    const ok = rows.filter((r) => r.status === 'OK').length;
    res.json({ token, rows, ok, total: rows.length, version: payload.version || '' });
  });
});

// GET /download/:token
router.get('/download/:token', (req, res) => {
  const job = JOBS.get(req.params.token);
  if (!job || !fs.existsSync(job.file)) {
    return res.status(404).send('This register has expired. Please process the files again.');
  }
  // A token is a bearer credential, but tie it to its creator anyway so one
  // staffer's register can't be pulled by another who guessed/observed the token.
  if (job.userId && job.userId !== req.user?.id) {
    return res.status(403).send('This register belongs to another user.');
  }
  res.download(job.file, 'Fee_Register.xlsx');
});

// Sweep expired jobs.
setInterval(() => {
  const now = Date.now();
  for (const [t, j] of JOBS) if (j.expires < now) { cleanup(j.dir); JOBS.delete(t); }
}, 5 * 60 * 1000).unref();

export default router;
