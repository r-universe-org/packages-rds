// packages-rds — serialize an array of JSON records into R's PACKAGES.rds format.
//
// The output is an RDS stream (XDR, serialization format 2) holding a single R
// object: a character matrix (STRSXP with a `dim` attribute), exactly like
// CRAN's PACKAGES.rds. It can be read back with readRDS() or unserialize().
//
// The stream is uncompressed by default; with the `compress` option it can be
// gzip- or xz-compressed just like saveRDS(). readRDS() detects the compression
// from the leading magic bytes, so no extra flag is needed when reading back.
//
// RDS layout produced here:
//
//   "X\n"                          XDR (big-endian) format marker
//   int  2                         serialization format version
//   int  writer R version
//   int  minimum reader R version
//   <STRSXP with attributes>       the character matrix, stored column-major
//     dim      = c(nrow, ncol)
//     dimnames = list(rownames, colnames)
//
// Every integer below is a 32-bit big-endian (XDR) value.

import zlib from "node:zlib";
import { promisify } from "node:util";

// SEXP type codes and serialization flag bits (see R's src/main/serialize.c).
const CHARSXP = 9;
const LISTSXP = 2;
const SYMSXP = 1;
const INTSXP = 13;
const STRSXP = 16;
const VECSXP = 19;
const NILVALUE_SXP = 254;

const HAS_ATTR = 1 << 9; //  attributes follow the object's data
const HAS_TAG = 1 << 10; // pairlist node carries a tag (the attribute name)

// CHARSXP "encoding" level bit (stored in the high bits of the flags integer).
// We always emit UTF-8 — R's native string encoding on every platform today.
const LEVEL_UTF8 = 8; // 1<<3

// A minimal growable big-endian byte writer. Writes into a single buffer which is
// doubled when full, rather than allocating a small buffer for every value, which
// is slow and causes a lot of garbage collection for large indexes.
class Writer {
  constructor(capacity = 65536) {
    this.buf = Buffer.allocUnsafe(capacity);
    this.length = 0;
  }
  reserve(n) {
    if (this.length + n <= this.buf.length) return;
    let capacity = this.buf.length * 2;
    while (capacity < this.length + n) capacity *= 2;
    const buf = Buffer.allocUnsafe(capacity);
    this.buf.copy(buf, 0, 0, this.length);
    this.buf = buf;
  }
  bytes(buf) {
    this.reserve(buf.length);
    buf.copy(this.buf, this.length);
    this.length += buf.length;
  }
  int(value) {
    this.reserve(4);
    this.buf.writeInt32BE(value, this.length);
    this.length += 4;
  }
  // Writes the utf8 byte length of a string (int) followed by the bytes.
  utf8(value) {
    this.reserve(4 + value.length * 3); // a UTF-16 code unit is at most 3 utf8 bytes
    const n = this.buf.write(value, this.length + 4, "utf8");
    this.buf.writeInt32BE(n, this.length);
    this.length += 4 + n;
  }
  result() {
    return Buffer.from(this.buf.subarray(0, this.length)); // copy, to release the slack
  }
}

// Turn a cell value into either a JS string or `null` (meaning R's NA).
// null/undefined become NA; everything else is stringified the way R would
// print it as.character(): plain decimal numbers, "TRUE"/"FALSE" for logicals.
function toCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

// Write one element of a character vector: an NA, or a CHARSXP of UTF-8 bytes
// tagged with the UTF-8 encoding bit. (R reports pure-ASCII content as encoding
// "unknown" regardless, since ASCII is a subset of UTF-8.)
function writeChar(w, value) {
  if (value === null) {
    w.int(CHARSXP); // flags, encoding level 0
    w.int(-1); // length -1 marks NA_STRING
    return;
  }
  w.int(CHARSXP | (LEVEL_UTF8 << 12));
  w.utf8(value);
}

// Write a character vector (STRSXP) from an array of strings/nulls.
function writeStrsxp(w, values) {
  w.int(STRSXP);
  w.int(values.length);
  for (const v of values) writeChar(w, v);
}

// Write a symbol (used for the attribute names "dim" and "dimnames").
function writeSymbol(w, name) {
  w.int(SYMSXP);
  writeChar(w, name);
}

// Apply the requested compression to the finished RDS bytes.
//   - false / undefined  -> no compression
//   - "gzip"             -> gzip   (built into Node)
//   - "zstd"             -> zstd   (built into Node >= 22.15 / 23.8; read by R >= 4.4)
//   - function           -> a custom compressor, e.g. to produce xz:
//                             compress: (b) => lzma.compress(b)   // 'lzma-native'
// Modern readRDS() recognises gzip/bzip2/xz/zstd from their magic bytes, so any
// of these streams reads back without an explicit flag.
function compressBytes(bytes, compress) {
  if (!compress) return bytes;
  if (compress === "gzip") return zlib.gzipSync(bytes);
  if (compress === "zstd") {
    if (typeof zlib.zstdCompressSync !== "function") {
      throw new Error("zstd compression requires Node >= 22.15 / 23.8");
    }
    return zlib.zstdCompressSync(bytes);
  }
  if (typeof compress === "function") return compress(bytes);
  throw new TypeError(`unsupported compress option: ${String(compress)}`);
}

// Same as compressBytes() but gzip/zstd run on the libuv threadpool, so they do
// not block the event loop.
function compressBytesAsync(bytes, compress) {
  if (compress === "gzip") return promisify(zlib.gzip)(bytes);
  if (compress === "zstd" && typeof zlib.zstdCompress === "function") {
    return promisify(zlib.zstdCompress)(bytes);
  }
  return Promise.resolve().then(() => compressBytes(bytes, compress));
}

// The columns of a typical PACKAGES index, used when `columns` is omitted.
export const DEFAULT_COLUMNS = [
  "Package",
  "Version",
  "NeedsCompilation",
  "Depends",
  "Imports",
  "LinkingTo",
  "Suggests",
  "Enhances",
  "OS_type",
  "SHA256",
  "Archs",
  "Path",
  "File",
  "SystemRequirements",
  "Built",
];

/**
 * Serialize an array of records into an RDS character matrix.
 *
 * Row names are always the matrix's `Package` column.
 *
 * @param {object[]} data     Array of records (plain objects).
 * @param {object}   [options]
 * @param {string[]} [options.columns]
 *        Field names to use as the matrix columns. Defaults to DEFAULT_COLUMNS
 *        (the usual PACKAGES fields).
 * @param {false|"gzip"|"zstd"|((bytes: Buffer) => Buffer)} [options.compress]
 *        Compression for the output: false (default, uncompressed), "gzip",
 *        "zstd", or a custom function (e.g. an xz encoder) taking and
 *        returning bytes.
 * @returns {Buffer} the RDS bytes, compressed per `options.compress`.
 */
export function packagesRDS(data, options = {}) {
  return compressBytes(serializeMatrix(data, options), options.compress);
}

/**
 * Same as packagesRDS() but returns a Promise, and gzip/zstd compression runs on
 * the libuv threadpool instead of blocking the event loop. Use this in servers.
 *
 * @param {object[]} data     Array of records (plain objects).
 * @param {object}   [options] Same as packagesRDS().
 * @returns {Promise<Buffer>} the RDS bytes, compressed per `options.compress`.
 */
export function packagesRDSAsync(data, options = {}) {
  return Promise.resolve()
    .then(() => serializeMatrix(data, options))
    .then((bytes) => compressBytesAsync(bytes, options.compress));
}

// Serialize the records into an uncompressed RDS character matrix.
function serializeMatrix(data, options) {
  const { columns = DEFAULT_COLUMNS } = options;
  if (!Array.isArray(data)) throw new TypeError("data must be an array of records");
  if (!Array.isArray(columns)) throw new TypeError("columns must be an array of field names");

  const nrow = data.length;
  const ncol = columns.length;
  // Row names are always the Package column.
  const rowNames = data.map((record) =>
    "Package" in record ? toCell(record.Package) : null
  );

  // R matrices are column-major: fill all rows of column 0, then column 1, ...
  const cells = new Array(nrow * ncol);
  let i = 0;
  for (let c = 0; c < ncol; c++) {
    const field = columns[c];
    for (let r = 0; r < nrow; r++) {
      const record = data[r];
      cells[i++] = field in record ? toCell(record[field]) : null;
    }
  }

  const w = new Writer();

  // --- RDS header (XDR, format version 2) ---
  w.bytes(Buffer.from([0x58, 0x0a])); // "X\n" — XDR (big-endian) format marker
  w.int(2); //          serialization version
  w.int(0x040600); //   written by R 4.6.0
  w.int(0x020300); //   readable by R >= 2.3.0

  // --- the matrix: a STRSXP carrying attributes ---
  w.int(STRSXP | HAS_ATTR);
  w.int(cells.length);
  for (const cell of cells) writeChar(w, cell);

  // attribute 1: dim = c(nrow, ncol)
  w.int(LISTSXP | HAS_TAG);
  writeSymbol(w, "dim");
  w.int(INTSXP);
  w.int(2);
  w.int(nrow);
  w.int(ncol);

  // attribute 2: dimnames = list(rownames, colnames)
  w.int(LISTSXP | HAS_TAG);
  writeSymbol(w, "dimnames");
  w.int(VECSXP);
  w.int(2);
  writeStrsxp(w, rowNames);
  writeStrsxp(w, columns.map(String));

  // terminate the attribute pairlist
  w.int(NILVALUE_SXP);

  return w.result();
}

export default packagesRDS;
