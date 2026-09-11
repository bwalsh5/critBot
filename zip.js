/**
 * Minimal ZIP writer — enough to bundle the usage export, with no dependency.
 *
 * Writes a standard (non-Zip64) archive: local file headers, a central
 * directory, and an end-of-central-directory record. Entries are deflated
 * unless that makes them bigger, which is the usual case for PNG and JPEG
 * payloads that are already compressed.
 */
import { crc32, deflateRawSync } from 'zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800; // names are UTF-8, not CP437

/** Packs a Date into the DOS date/time pair ZIP uses. */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    (Math.floor(date.getSeconds() / 2));
  const day =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, day };
}

/**
 * Builds a ZIP archive in memory.
 *
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @param {Date} [now] timestamp stamped on every entry
 * @returns {Buffer}
 */
export function createZip(entries, now = new Date()) {
  const { time, day } = dosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const checksum = crc32(raw);

    // Deflate only when it actually helps; already-compressed images do not.
    const deflated = raw.length > 0 ? deflateRawSync(raw) : Buffer.alloc(0);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length

    chunks.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL_SIG, 0);
    dir.writeUInt16LE(20, 4);            // version made by
    dir.writeUInt16LE(20, 6);            // version needed
    dir.writeUInt16LE(UTF8_FLAG, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);            // extra
    dir.writeUInt16LE(0, 32);            // comment
    dir.writeUInt16LE(0, 34);            // disk number start
    dir.writeUInt16LE(0, 36);            // internal attrs
    dir.writeUInt32LE(0, 38);            // external attrs
    dir.writeUInt32LE(offset, 42);       // local header offset

    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);                     // this disk
  eocd.writeUInt16LE(0, 6);                     // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                    // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** Quotes a value for RFC 4180 CSV. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Builds a CSV document from a column list and row objects. */
export function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c])).join(','));
  }
  // Excel and read.csv() both cope with \r\n; R's readr prefers it too.
  return lines.join('\r\n') + '\r\n';
}
