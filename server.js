import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { appendFile, mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { createZip, toCsv } from './zip.js';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 1. TIMEOUT MIDDLEWARE: Generous ceiling. The critique route streams and
// clears its own timeout once the SSE connection is open.
app.use((req, res, next) => {
  res.setTimeout(300000, () => {
    console.error('❌ Request timed out after 300 seconds.');
    if (!res.headersSent) {
      res.status(504).json({ error: 'Gateway Timeout: Engine took too long.' });
    }
  });
  next();
});

// The client downscales before upload, but phone cameras are unpredictable.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 } // 12MB ceiling
});

/**
 * Identifies an image from its magic bytes.
 *
 * The browser-reported MIME type is not trustworthy: on macOS and Windows
 * `File.type` is derived from the file extension, so a JPEG saved as ".png"
 * arrives declared as image/png. Forwarding that declaration to the API gets
 * the whole request rejected, so the bytes decide.
 *
 * Returns null for anything that is not a format the API accepts.
 */
function sniffMediaType(buf) {
  if (buf.length < 12) return null;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';

  const head = buf.toString('latin1', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';

  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';

  return null;
}

/** Recognizes common formats the API rejects, so the error can name them. */
function describeUnsupported(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'HEIC/HEIF (an iPhone photo)';
    if (/^avif$/.test(brand)) return 'AVIF';
  }
  if (buf.toString('latin1', 0, 5) === '<?xml' || buf.toString('latin1', 0, 4) === '<svg') return 'SVG';
  if (buf.toString('latin1', 0, 2) === 'BM') return 'BMP';
  return null;
}

// Verify API key initialization
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ CRITICAL ERROR: ANTHROPIC_API_KEY is missing from your environment/env file!");
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.static(path.join(__dirname, 'public')));

const MODEL = 'claude-opus-5';

// Thinking tokens were ~42% of output spend at effort 'high', and output is
// ~82% of the bill. 'medium' is the cost lever; raise it back if critique
// specificity drops off.
const EFFORT = 'medium';

/**
 * claude-opus-5 rates, USD per million tokens. Cache reads bill at 0.1x input
 * and cache writes at 1.25x. Update these if the model changes.
 */
const PRICING = { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 };

const LOG_DIR = path.join(__dirname, 'logs');
const USAGE_LOG = path.join(LOG_DIR, 'usage.jsonl');
const IMAGE_DIR = path.join(LOG_DIR, 'images');
const CRITIQUE_DIR = path.join(LOG_DIR, 'critiques');

const EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

/**
 * Run ids are zero-padded sequential numbers, so the saved artefacts read as
 * numbered slides (images/0001.png, critiques/0001.md) that join to runs.csv
 * on run_id. Seeded from the existing log so restarts do not collide.
 */
let runCounter = 0;
function seedRunCounter() {
  if (!existsSync(USAGE_LOG)) return;
  try {
    for (const line of readFileSync(USAGE_LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const n = parseInt(JSON.parse(line).runId, 10);
      if (Number.isFinite(n) && n > runCounter) runCounter = n;
    }
  } catch (err) {
    console.error('⚠️ Could not seed run counter, starting from 0:', err.message);
  }
}
seedRunCounter();

function nextRunId() {
  runCounter += 1;
  return String(runCounter).padStart(4, '0');
}

/** Rough image-token estimate from dimensions; see docs in README of costs. */
function estimateImageTokens(dimensions) {
  if (!dimensions) return null;
  // Measured on claude-opus-5: ~w*h/750, clamped at a ceiling of ~4743.
  return Math.min(Math.round((dimensions.width * dimensions.height) / 750), 4743);
}

/** Reads every logged run, newest last. */
function readRuns() {
  if (!existsSync(USAGE_LOG)) return [];
  return readFileSync(USAGE_LOG, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Converts a usage object from the API into a dollar figure. */
function priceUsage(usage) {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  const cost =
    (input * PRICING.input +
     output * PRICING.output +
     cacheRead * PRICING.cacheRead +
     cacheWrite * PRICING.cacheWrite) / 1e6;

  return { input, output, cacheRead, cacheWrite, cost };
}

/**
 * Reads pixel dimensions from the header bytes. Image tokens are billed on
 * dimensions, so this is the number that explains a given run's input cost.
 * Returns null for formats not worth parsing here (WebP's several variants).
 */
function readDimensions(buf, mediaType) {
  try {
    if (mediaType === 'image/png') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mediaType === 'image/gif') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mediaType === 'image/webp') {
      // Bytes 0-11 are the RIFF/WEBP header; the variant tag follows at 12.
      const variant = buf.toString('latin1', 12, 16);

      if (variant === 'VP8 ') {
        // Lossy: 3-byte frame tag, then the 0x9d012a start code at 23.
        if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff
        };
      }
      if (variant === 'VP8L') {
        // Lossless: 0x2f signature, then two 14-bit fields holding size - 1.
        if (buf[20] !== 0x2f) return null;
        const bits = buf.readUInt32LE(21);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1
        };
      }
      if (variant === 'VP8X') {
        // Extended (animation, alpha, ICC): 24-bit canvas size - 1.
        return {
          width: buf.readUIntLE(24, 3) + 1,
          height: buf.readUIntLE(27, 3) + 1
        };
      }
      return null;
    }
    if (mediaType === 'image/jpeg') {
      // Walk the marker segments looking for a Start-Of-Frame.
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        // SOF0-SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {
    // A truncated or unusual header is not worth failing the request over.
  }
  return null;
}

/** Appends one line of JSON per run. Never allowed to break a response. */
async function logUsage(record) {
  try {
    await mkdir(path.dirname(USAGE_LOG), { recursive: true });
    await appendFile(USAGE_LOG, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('⚠️ Could not write usage log:', err.message);
  }
}

/**
 * The selectable analysis lenses. `id` is the wire value the UI sends,
 * `label` is what the UI renders, `brief` is what Claude is told the lens means
 * so the critique stays specific instead of restating the term back.
 */
const DESIGN_ASPECTS = [
  {
    id: 'visual-hierarchy',
    label: 'Visual hierarchy',
    brief: 'Does scale, weight, and position rank the content in the order a viewer should absorb it? Name the actual reading order you observe and where it diverges from the intended one.'
  },
  {
    id: 'emphasis',
    label: 'Emphasis',
    brief: 'What is the dominant element, and is it the element that deserves dominance? Look for competing focal points and under-served ones.'
  },
  {
    id: 'movement',
    label: 'Movement',
    brief: 'Trace the path the eye takes through the composition. Identify dead ends, places the path stalls, and whether it terminates somewhere useful.'
  },
  {
    id: 'proximity',
    label: 'Proximity',
    brief: 'Does spacing group related content and separate unrelated content? Flag items that read as belonging together but do not, and vice versa.'
  },
  {
    id: 'alignment',
    label: 'Alignment',
    brief: 'Is there a discernible underlying grid? Identify edges that almost align (the worst case) and elements placed without apparent reference.'
  },
  {
    id: 'white-space',
    label: 'White space',
    brief: 'Assess negative space as an active material: breathing room around key elements, margin consistency, crowding, and unintentional trapped space.'
  },
  {
    id: 'typographic-readability',
    label: 'Typographic readability',
    brief: 'Evaluate size, leading, measure, line breaks, contrast, and case at the distance and medium this design will actually be read from. Comment on whether line breaks follow linguistic structure or available width.'
  },
  {
    id: 'gestalt',
    label: 'Gestalt similarity / common region',
    brief: 'Where does shared treatment (color, shape, weight) or an enclosing region imply a relationship? Note relationships implied but not intended, and intended but not implied.'
  },
  {
    id: 'task-hierarchy',
    label: 'Task-oriented information hierarchy',
    brief: 'Identify the action or takeaway this design exists to produce, then judge whether visual prominence matches task importance. Call out any gap between communication hierarchy and task hierarchy.'
  }
];

const ASPECTS_BY_ID = new Map(DESIGN_ASPECTS.map((a) => [a.id, a]));

const SYSTEM_PROMPT = `You are an objective, elite Design Director delivering a rigorous, constructive graphic design critique of an image the user has supplied.

VOICE
- Write as a senior practitioner talking to another practitioner. Direct, specific, unsentimental.
- No self-reference, no mention of being an AI or a model, no preamble, no "great question," no offers to help further.
- Never praise reflexively. A strength is only a strength if you can say what it accomplishes.
- Every criticism must be actionable: say what you would change, not merely that something is weak.
- Judge the design against the job it is doing and the distance/medium it will be viewed at. Infer that context from the image.

EVIDENCE
- Anchor claims to what is actually visible: name the specific element, its position, its relative size.
- Distinguish what you can see from what you are inferring. If a judgment depends on context the image does not show, say so rather than asserting it.
- Do not invent content, brand names, or copy that is not legible in the image.

OUTPUT FORMAT
Respond in Markdown using exactly these five sections, in this order, with these headings:

## 1. Overall impression
Two or three sentences on what this reads as and whether the concept lands. Then a line beginning "Confidence:" stating your confidence in the critique and naming anything that limits it (image quality, cropping, missing context).

## 2. Strengths
The things genuinely working, each with a short bold lead-in phrase followed by why it works. Three to five items. If something is merely adequate, do not list it.

## 3. Highest-priority improvements
The two to four changes that would most improve the design, ordered by impact, numbered, each with a bold title. For each: state the problem, name the principle at stake, and describe the specific intervention you would make. Be concrete about what moves, resizes, or gets added.

## 4. Additional suggestions
Smaller refinements, production considerations, and anything visible in the image about physical execution or context. A short paragraph or a few items.

## 5. Design principles referenced
One short paragraph naming the principles that drove this critique, then a closing judgment on the scope of change required — specifically, what identity elements you would preserve versus what you would rebuild. Favor targeted structural change over stylistic overhaul unless the design genuinely warrants one.

Keep the whole critique tight. Length should serve the analysis, not perform thoroughness.`;

/**
 * Builds the per-request instruction. Kept out of the system prompt so the
 * system prefix stays byte-stable across requests.
 */
function buildUserPrompt(aspects, note) {
  const lines = [];

  if (aspects.length === DESIGN_ASPECTS.length) {
    lines.push('Critique this design across the full set of principles below.');
  } else {
    const scope = aspects.length === 1
      ? 'the single principle below — it is'
      : `these ${aspects.length} principles — they are`;
    lines.push(
      `Critique this design. Focus your analysis on ${scope} what the reviewer asked about, so the critique should be built around ${aspects.length === 1 ? 'it' : 'them'}. You may mention another principle only where it is unavoidable to explain ${aspects.length === 1 ? 'this one' : 'one of these'}.`
    );
  }

  lines.push('');
  for (const aspect of aspects) {
    lines.push(`- **${aspect.label}** — ${aspect.brief}`);
  }
  lines.push('');
  lines.push(
    'In section 5, reference only the principles listed above. Do not pad the critique to cover every listed principle equally; weight them by how much they actually matter to this design.'
  );

  if (note) {
    lines.push('');
    lines.push(`Additional context from the designer: ${note}`);
  }

  return lines.join('\n');
}

/** Parses and validates the `aspects` field. Falls back to all aspects. */
function resolveAspects(raw) {
  if (!raw) return DESIGN_ASPECTS;

  let ids;
  try {
    ids = JSON.parse(raw);
  } catch {
    return DESIGN_ASPECTS;
  }
  if (!Array.isArray(ids)) return DESIGN_ASPECTS;

  // Preserve the canonical order rather than whatever order the client sent.
  const requested = new Set(ids.filter((id) => ASPECTS_BY_ID.has(id)));
  const resolved = DESIGN_ASPECTS.filter((a) => requested.has(a.id));

  return resolved.length > 0 ? resolved : DESIGN_ASPECTS;
}

// Expose the aspect list so the UI never hardcodes a second copy.
app.get('/api/aspects', (req, res) => {
  res.json({ aspects: DESIGN_ASPECTS.map(({ id, label }) => ({ id, label })) });
});

/**
 * One row per analysis. Deliberately flat and typed for R: read.csv() then
 * join images/critiques by run_id. Aspects are semicolon-joined (commas would
 * fight the format) plus one 0/1 indicator column per aspect, which is what
 * you actually want for modelling.
 */
const CSV_COLUMNS = [
  'run_id', 'timestamp', 'model', 'effort',
  'original_filename', 'media_type', 'bytes', 'width', 'height', 'megapixels',
  'oversized', 'image_tokens_est',
  'aspect_count', 'aspects',
  ...DESIGN_ASPECTS.map((a) => 'lens_' + a.id.replace(/-/g, '_')),
  'has_note', 'note',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'cost_usd', 'seconds', 'stop_reason',
  'critique_chars', 'image_file', 'critique_file'
];

function toCsvRow(r) {
  const selected = new Set(r.aspects || []);
  const row = {
    run_id: r.runId ?? '',
    timestamp: r.at,
    model: r.model,
    effort: r.effort ?? '',
    original_filename: r.file,
    media_type: r.mediaType,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    megapixels: r.width && r.height ? Number(((r.width * r.height) / 1e6).toFixed(3)) : '',
    oversized: r.width && r.height ? (Math.max(r.width, r.height) > 1568 ? 1 : 0) : '',
    image_tokens_est: r.imageTokensEst ?? '',
    aspect_count: (r.aspects || []).length,
    aspects: (r.aspects || []).join(';'),
    has_note: r.hasNote ? 1 : 0,
    note: r.note ?? '',
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cache_read_tokens: r.cacheReadTokens ?? 0,
    cache_write_tokens: r.cacheWriteTokens ?? 0,
    cost_usd: r.costUsd,
    seconds: r.seconds,
    stop_reason: r.stopReason,
    critique_chars: r.critiqueChars ?? '',
    image_file: r.imageFile ?? '',
    critique_file: r.critiqueFile ?? ''
  };
  for (const a of DESIGN_ASPECTS) {
    row['lens_' + a.id.replace(/-/g, '_')] = selected.has(a.id) ? 1 : 0;
  }
  return row;
}

function exportStamp() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// Summary of logged runs, for the UI history panel.
app.get('/api/runs', (req, res) => {
  const runs = readRuns();
  res.json({
    count: runs.length,
    totalCostUsd: Number(runs.reduce((t, r) => t + (r.costUsd || 0), 0).toFixed(6)),
    runs: runs.slice(-50).reverse()
  });
});

// Tabular data only.
app.get('/api/export.csv', (req, res) => {
  const runs = readRuns();
  if (runs.length === 0) return res.status(404).json({ error: 'No runs logged yet.' });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="critbot-runs-${exportStamp()}.csv"`);
  res.send(toCsv(CSV_COLUMNS, runs.map(toCsvRow)));
});

// Everything: CSV + the submitted images + the critique text, joined by run_id.
app.get('/api/export.zip', async (req, res) => {
  try {
    const runs = readRuns();
    if (runs.length === 0) return res.status(404).json({ error: 'No runs logged yet.' });

    const entries = [
      { name: 'runs.csv', data: toCsv(CSV_COLUMNS, runs.map(toCsvRow)) },
      { name: 'README.txt', data: buildReadme(runs) }
    ];

    let missing = 0;
    for (const r of runs) {
      for (const rel of [r.imageFile, r.critiqueFile]) {
        if (!rel) continue;
        try {
          entries.push({ name: rel, data: await readFile(path.join(LOG_DIR, rel)) });
        } catch {
          missing++; // an artefact deleted or never written; the CSV row stays
        }
      }
    }
    if (missing) console.warn(`⚠️ ${missing} archived file(s) missing from disk.`);

    const zip = createZip(entries);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="critbot-export-${exportStamp()}.zip"`);
    res.setHeader('Content-Length', zip.length);
    console.log(`📦 Export: ${runs.length} runs, ${entries.length} files, ${(zip.length / 1024).toFixed(0)}KB`);
    return res.send(zip);
  } catch (err) {
    console.error('❌ Export failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

function buildReadme(runs) {
  const total = runs.reduce((t, r) => t + (r.costUsd || 0), 0);
  return [
    'critBot usage export',
    'Generated: ' + new Date().toISOString(),
    '',
    `${runs.length} runs, ${total.toFixed(4)} total API spend.`,
    '',
    'CONTENTS',
    '  runs.csv          one row per analysis, keyed by run_id',
    '  images/<id>.<ext> the exact image bytes submitted for that run',
    '  critiques/<id>.md the feedback text returned for that run',
    '',
    'JOINING IN R',
    '  runs <- read.csv("runs.csv", stringsAsFactors = FALSE)',
    '  runs$critique <- sapply(runs$critique_file, function(p)',
    '      if (nzchar(p) && file.exists(p)) paste(readLines(p, warn = FALSE), collapse = "\\n") else NA)',
    '  lenses <- runs[, grep("^lens_", names(runs))]   # 0/1 indicator matrix',
    '',
    '  IMPORTANT: read.csv() parses run_id as an integer and drops the zero',
    '  padding (0001 -> 1), so do NOT rebuild paths with paste0("images/",',
    '  run_id). Use the image_file and critique_file columns, which hold the',
    '  correct relative paths. To keep the padding, read with',
    '    read.csv("runs.csv", colClasses = c(run_id = "character"))',
    '',
    'NOTES',
    '  cost_usd is computed from the token counts using the rates below, not',
    '  billed amounts. Reconcile against the Anthropic console before invoicing.',
    `    input ${PRICING.input}/Mtok, output ${PRICING.output}/Mtok,`,
    `    cache read ${PRICING.cacheRead}/Mtok, cache write ${PRICING.cacheWrite}/Mtok`,
    '',
    '  image_tokens_est is estimated from pixel dimensions (~w*h/750, capped',
    '  around 4743) and is NOT returned by the API. input_tokens is exact and',
    '  includes the image, system prompt, and user prompt together.',
    '',
    '  oversized = 1 means the long edge exceeded 1568px, where image tokens',
    '  clamp to the ceiling. Those runs paid the maximum image cost.',
    '',
    '  aspect_<name> columns are 0/1 indicators for each analysis lens.',
    ''
  ].join('\n');
}

// 2. ERROR-INSULATED STREAMING ROUTE
app.post('/api/critique', (req, res) => {
  console.log('📬 [1/4] Incoming payload detected at /api/critique...');

  // Explicitly catch Multer middleware parsing blocks
  upload.single('designImage')(req, res, async function (err) {
    if (err) {
      console.error('❌ Multer Parsing Error:', err);
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image is too large. Keep it under 12MB.'
        : `File upload parsing error: ${err.message}`;
      return res.status(400).json({ error: message });
    }

    try {
      console.log('📂 [2/4] File successfully parsed by Multer.');

      if (!req.file) {
        console.error('❌ Request context reached route but req.file is undefined.');
        return res.status(400).json({ error: 'No image file found in payload data.' });
      }

      const mediaType = sniffMediaType(req.file.buffer);
      if (!mediaType) {
        const guess = describeUnsupported(req.file.buffer);
        return res.status(400).json({
          error: guess
            ? `That looks like ${guess}, which can't be analyzed. Convert it to JPEG or PNG first.`
            : "That file isn't a readable JPEG, PNG, GIF, or WebP image."
        });
      }

      const aspects = resolveAspects(req.body.aspects);
      const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 500) : '';

      if (req.file.mimetype !== mediaType) {
        console.warn(`⚠️ Declared ${req.file.mimetype} but bytes are ${mediaType} — using the sniffed type.`);
      }
      console.log(`🖼️ ${req.file.originalname} | ${mediaType} | ${req.file.size} bytes`);
      console.log(`🎯 Lenses: ${aspects.map((a) => a.id).join(', ')}`);

      const dimensions = readDimensions(req.file.buffer, mediaType);
      if (dimensions) {
        const oversized = Math.max(dimensions.width, dimensions.height) > 1568;
        console.log(`📐 ${dimensions.width}x${dimensions.height}${oversized ? '  ⚠️ over 1568px — billed at the image-token ceiling' : ''}`);
      }

      const startedAt = Date.now();
      const base64Image = req.file.buffer.toString('base64');

      // Open the SSE channel before the API call so the client gets immediate
      // feedback, and drop the socket timeout now that we own the connection.
      res.setTimeout(0);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders?.();

      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send('status', { message: 'Reading the composition…' });

      console.log('📡 [3/4] Dispatching image payload to Anthropic API...');

      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64Image,
                },
              },
              {
                type: 'text',
                text: buildUserPrompt(aspects, note),
              },
            ],
          },
        ],
      });

      // If the user navigates away mid-critique, stop paying for the rest.
      // Listen on `res`, not `req` — `req` emits 'close' as soon as the
      // multipart body is fully consumed, which is long before the client leaves.
      res.on('close', () => {
        if (!res.writableEnded) {
          console.log('🔌 Client disconnected — aborting stream.');
          stream.abort();
        }
      });

      let critique = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          critique += event.delta.text;
          send('delta', { text: event.delta.text });
        }
      }

      const final = await stream.finalMessage();

      if (final.stop_reason === 'refusal') {
        send('error', { error: 'The model declined to analyze this image.' });
      } else if (final.stop_reason === 'max_tokens') {
        send('status', { message: 'Critique truncated at the output limit.' });
      }

      const u = priceUsage(final.usage);
      const elapsed = (Date.now() - startedAt) / 1000;

      console.log(
        `💰 in ${u.input} + out ${u.output}` +
        (u.cacheRead ? ` + cacheRead ${u.cacheRead}` : '') +
        (u.cacheWrite ? ` + cacheWrite ${u.cacheWrite}` : '') +
        ` = ${u.cost.toFixed(4)} in ${elapsed.toFixed(1)}s`
      );

      const runId = nextRunId();
      const ext = EXTENSION[mediaType];
      const imageFile = `images/${runId}.${ext}`;
      const critiqueFile = `critiques/${runId}.md`;

      // Archive the exact bytes analyzed and the feedback given. A storage
      // failure must not lose the critique the user is already reading.
      let archived = true;
      try {
        await mkdir(IMAGE_DIR, { recursive: true });
        await mkdir(CRITIQUE_DIR, { recursive: true });
        await writeFile(path.join(LOG_DIR, imageFile), req.file.buffer);
        await writeFile(path.join(LOG_DIR, critiqueFile), critique);
      } catch (err) {
        archived = false;
        console.error('⚠️ Could not archive run artefacts:', err.message);
      }

      const record = {
        runId: runId,
        at: new Date().toISOString(),
        model: MODEL,
        effort: EFFORT,
        file: req.file.originalname,
        mediaType: mediaType,
        bytes: req.file.size,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        imageTokensEst: estimateImageTokens(dimensions),
        aspects: aspects.map((a) => a.id),
        hasNote: Boolean(note),
        note: note,
        inputTokens: u.input,
        outputTokens: u.output,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
        costUsd: Number(u.cost.toFixed(6)),
        seconds: Number(elapsed.toFixed(1)),
        stopReason: final.stop_reason,
        critiqueChars: critique.length,
        imageFile: archived ? imageFile : null,
        critiqueFile: archived ? critiqueFile : null
      };
      await logUsage(record);

      console.log(`📦 Archived as run ${runId}${archived ? '' : ' (artefacts failed)'}`);
      console.log('✅ [4/4] Claude responded successfully.');

      // The receipt the UI renders.
      send('done', {
        stopReason: final.stop_reason,
        receipt: {
          runId: runId,
          model: MODEL,
          effort: EFFORT,
          at: record.at,
          seconds: record.seconds,
          width: record.width,
          height: record.height,
          mediaType: mediaType,
          bytes: req.file.size,
          imageTokensEst: record.imageTokensEst,
          inputTokens: u.input,
          outputTokens: u.output,
          cacheReadTokens: u.cacheRead,
          cacheWriteTokens: u.cacheWrite,
          pricing: PRICING,
          costUsd: Number(u.cost.toFixed(6))
        }
      });
      return res.end();

    } catch (apiError) {
      if (apiError instanceof Anthropic.APIUserAbortError) {
        console.log('🔌 Stream aborted.');
        return res.end();
      }

      console.error('❌ Anthropic SDK Exception Occurred:', apiError);

      const message = apiError instanceof Anthropic.AuthenticationError
        ? 'API key was rejected. Check ANTHROPIC_API_KEY.'
        : apiError instanceof Anthropic.RateLimitError
          ? 'Rate limited. Wait a moment and try again.'
          : `Claude SDK failed to respond: ${apiError.message || 'Internal connection fault'}`;

      // Headers are already sent once streaming has begun, so report in-band.
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        return res.end();
      }
      return res.status(500).json({ error: message });
    }
  });
});

// 3. GLOBAL FALLBACK ERROR HANDLER
app.use((err, req, res, next) => {
  console.error('💥 Uncaught Express Error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server crash.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Critique engine live on http://localhost:${PORT}`));
