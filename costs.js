/**
 * Summarizes logs/usage.jsonl — what the critique engine has cost so far.
 *
 *   node costs.js            all runs
 *   node costs.js 7          runs from the last 7 days
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, 'logs', 'usage.jsonl');

if (!fs.existsSync(LOG)) {
  console.log('No usage log yet — run an analysis first. (Expected at logs/usage.jsonl)');
  process.exit(0);
}

const days = Number(process.argv[2]) || null;
const cutoff = days ? Date.now() - days * 86400000 : 0;

const runs = fs.readFileSync(LOG, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      console.error(`⚠️ Skipping malformed line ${i + 1}`);
      return null;
    }
  })
  .filter((r) => r && new Date(r.at).getTime() >= cutoff);

if (runs.length === 0) {
  console.log(days ? `No runs in the last ${days} days.` : 'No runs logged.');
  process.exit(0);
}

const sum = (key) => runs.reduce((t, r) => t + (r[key] || 0), 0);
const total = sum('costUsd');
const money = (n) => '$' + n.toFixed(4);

console.log(`\n${runs.length} run${runs.length === 1 ? '' : 's'}` +
  (days ? ` in the last ${days} days` : '') +
  `  ·  ${runs[0].at.slice(0, 10)} → ${runs[runs.length - 1].at.slice(0, 10)}\n`);

console.log('TOTAL        ' + money(total));
console.log('Per run      ' + money(total / runs.length) + ' avg' +
  `   (${money(Math.min(...runs.map((r) => r.costUsd)))} – ${money(Math.max(...runs.map((r) => r.costUsd)))})`);
console.log('Tokens       ' + sum('inputTokens').toLocaleString() + ' in  ·  ' +
  sum('outputTokens').toLocaleString() + ' out');
console.log('Avg latency  ' + (sum('seconds') / runs.length).toFixed(1) + 's');

// Oversized images are the one lever that is purely waste: past ~1568px on the
// long edge the extra pixels are clamped away but still billed at the ceiling.
const oversized = runs.filter((r) => r.width && Math.max(r.width, r.height) > 1568);
if (oversized.length) {
  console.log(`\n⚠️  ${oversized.length} of ${runs.length} runs sent an image over 1568px.`);
  console.log('   Those bill at the image-token ceiling (~4,743 tokens ≈ $0.024 on opus-5)');
  console.log('   versus ~2,355 tokens ≈ $0.012 when resized. The browser normally');
  console.log('   handles this, so these likely came from a non-browser client.');
}

const truncated = runs.filter((r) => r.stopReason === 'max_tokens');
if (truncated.length) {
  console.log(`\n⚠️  ${truncated.length} run(s) hit max_tokens and were cut off mid-critique.`);
}

// Effort is the dominant cost lever, so surface it whenever a log spans a
// change. Runs written before effort was recorded show as "unrecorded".
const byEffort = new Map();
for (const r of runs) {
  const key = r.effort || 'unrecorded';
  const e = byEffort.get(key) || { runs: 0, cost: 0, out: 0, secs: 0 };
  e.runs++; e.cost += r.costUsd; e.out += r.outputTokens || 0; e.secs += r.seconds || 0;
  byEffort.set(key, e);
}
if (byEffort.size > 1) {
  console.log('\neffort        runs   avg cost   avg output   avg time');
  console.log('--------------------------------------------------------');
  for (const [k, e] of byEffort) {
    console.log(
      k.padEnd(12), String(e.runs).padStart(5),
      money(e.cost / e.runs).padStart(11),
      String(Math.round(e.out / e.runs)).padStart(12),
      ((e.secs / e.runs).toFixed(0) + 's').padStart(11)
    );
  }
}

// Which lens combinations are actually being used, and what they cost.
const byCount = new Map();
for (const r of runs) {
  const n = r.aspects?.length ?? 0;
  const e = byCount.get(n) || { runs: 0, cost: 0, out: 0 };
  e.runs++; e.cost += r.costUsd; e.out += r.outputTokens || 0;
  byCount.set(n, e);
}
console.log('\naspects  runs   avg cost   avg output');
console.log('--------------------------------------');
for (const [n, e] of [...byCount].sort((a, b) => a[0] - b[0])) {
  console.log(
    String(n).padStart(7),
    String(e.runs).padStart(5),
    money(e.cost / e.runs).padStart(11),
    String(Math.round(e.out / e.runs)).padStart(12)
  );
}

console.log('\nrecent runs');
console.log('-----------');
for (const r of runs.slice(-10)) {
  const dims = r.width ? `${r.width}x${r.height}` : '—';
  console.log(
    r.at.slice(0, 16).replace('T', ' '),
    money(r.costUsd).padStart(9),
    dims.padStart(11),
    String(r.aspects?.length ?? 0).padStart(2) + ' lens',
    ' ' + (r.file || '').slice(0, 28)
  );
}
console.log();
