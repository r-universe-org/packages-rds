// Round-trip tests: serialize with packagesRDS(), then read the bytes back inside a
// real R session (running in WebAssembly via webR) using readRDS()/unserialize().
//
// Written with promise chains rather than async/await, as requested.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { WebR } from "webr";
import { packagesRDS, DEFAULT_COLUMNS } from "../src/index.js";

// Is the system `xz` tool available? (used for the optional xz round-trip)
const hasXz = spawnSync("xz", ["--version"]).status === 0;

const webR = new WebR();
const RDS_PATH = "/tmp/makerds-test.rds";

before(() => webR.init());
after(() => webR.close());

// Write `bytes` to the webR filesystem and assign `x <- readRDS(path)`.
// Returns a promise that resolves once `x` exists in the R global environment.
function loadMatrix(bytes) {
  return webR.FS
    .writeFile(RDS_PATH, new Uint8Array(bytes))
    .then(() => webR.evalRVoid(`x <- readRDS(${JSON.stringify(RDS_PATH)})`));
}

// Evaluate an R expression and return the plain JS values array from toJs().
// NA elements come back as null.
function rValues(code) {
  return webR.evalR(code).then((obj) =>
    Promise.resolve(obj.toJs()).then((js) => {
      webR.destroy(obj);
      return js.values;
    })
  );
}

test("basic 2x2 character matrix round-trips", () => {
  const data = [
    { Package: "abc", Version: "1.0" },
    { Package: "xyz", Version: "2.3" },
  ];
  return loadMatrix(packagesRDS(data, { columns: ["Package", "Version"] }))
    .then(() => Promise.all([
      rValues("dim(x)"),
      rValues("class(x)"),
      rValues("as.vector(x)"), // column-major
    ]))
    .then(([dim, klass, values]) => {
      assert.deepEqual(dim, [2, 2]);
      assert.deepEqual(klass, ["matrix", "array"]);
      assert.deepEqual(values, ["abc", "xyz", "1.0", "2.3"]);
    });
});

test("columns default to the standard PACKAGES fields", () => {
  const data = [{ Package: "abc", Version: "1.0", NeedsCompilation: "no" }];
  return loadMatrix(packagesRDS(data)) // no columns argument
    .then(() => Promise.all([
      rValues("colnames(x)"),
      rValues('as.vector(x[, c("Package", "Version", "NeedsCompilation")])'),
      rValues('as.logical(is.na(x[, "Depends"]))'), // present-but-empty record field -> NA
    ]))
    .then(([cols, present, dependsNA]) => {
      assert.deepEqual(cols, DEFAULT_COLUMNS);
      assert.deepEqual(present, ["abc", "1.0", "no"]);
      assert.deepEqual(dependsNA, [true]);
    });
});

test("missing fields become NA", () => {
  const data = [
    { Package: "abc", Priority: "recommended" },
    { Package: "xyz" }, // no Priority
  ];
  return loadMatrix(packagesRDS(data, { columns: ["Package", "Priority"] }))
    .then(() => Promise.all([
      rValues('as.vector(x[, "Priority"])'),
      rValues('as.logical(is.na(x[, "Priority"]))'),
    ]))
    .then(([priority, isNA]) => {
      assert.deepEqual(priority, ["recommended", null]);
      assert.deepEqual(isNA, [false, true]);
    });
});

test("numbers and booleans are stringified", () => {
  const data = [{ count: 42, ratio: 3.5, ok: true }];
  return loadMatrix(packagesRDS(data, { columns: ["count", "ratio", "ok"] }))
    .then(() => rValues("as.vector(x)"))
    .then((values) => assert.deepEqual(values, ["42", "3.5", "TRUE"]));
});

test("UTF-8 content is preserved and tagged", () => {
  const data = [{ Author: "Café Müller — 北京" }];
  return loadMatrix(packagesRDS(data, { columns: ["Author"] }))
    .then(() => Promise.all([
      rValues("as.vector(x)"),
      rValues("Encoding(as.vector(x))"),
    ]))
    .then(([values, enc]) => {
      assert.deepEqual(values, ["Café Müller — 北京"]);
      assert.deepEqual(enc, ["UTF-8"]);
    });
});

test("rownames are always the Package column", () => {
  const data = [
    { Package: "abc", Version: "1.0" },
    { Package: "xyz", Version: "2.3" },
  ];
  return loadMatrix(packagesRDS(data, { columns: ["Package", "Version"] }))
    .then(() => Promise.all([
      rValues("rownames(x)"),
      rValues("colnames(x)"),
    ]))
    .then(([rn, cn]) => {
      assert.deepEqual(rn, ["abc", "xyz"]);
      assert.deepEqual(cn, ["Package", "Version"]);
    });
});

test("gzip-compressed output round-trips", () => {
  const data = [{ Package: "abc", Version: "1.0" }, { Package: "xyz", Version: "2.3" }];
  const bytes = packagesRDS(data, { columns: ["Package", "Version"], compress: "gzip" });
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]); // gzip magic
  return loadMatrix(bytes)
    .then(() => rValues("as.vector(x)"))
    .then((values) => assert.deepEqual(values, ["abc", "xyz", "1.0", "2.3"]));
});

test("zstd-compressed output round-trips", () => {
  const data = [{ Package: "abc", Version: "1.0" }, { Package: "xyz", Version: "2.3" }];
  const bytes = packagesRDS(data, { columns: ["Package", "Version"], compress: "zstd" });
  assert.deepEqual([...bytes.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd]); // zstd magic
  return loadMatrix(bytes)
    .then(() => rValues("as.vector(x)"))
    .then((values) => assert.deepEqual(values, ["abc", "xyz", "1.0", "2.3"]));
});

test("xz-compressed output round-trips", { skip: !hasXz }, () => {
  const xz = (bytes) => spawnSync("xz", ["-c"], { input: bytes, maxBuffer: 1 << 30 }).stdout;
  const data = [{ Package: "abc", Version: "1.0" }, { Package: "xyz", Version: "2.3" }];
  const bytes = packagesRDS(data, { columns: ["Package", "Version"], compress: xz });
  assert.deepEqual([...bytes.subarray(0, 6)], [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]); // xz magic
  return loadMatrix(bytes)
    .then(() => rValues("as.vector(x)"))
    .then((values) => assert.deepEqual(values, ["abc", "xyz", "1.0", "2.3"]));
});

test("bytes are also readable with unserialize()", () => {
  const data = [{ Package: "abc" }, { Package: "xyz" }];
  return webR.FS
    .writeFile(RDS_PATH, new Uint8Array(packagesRDS(data, { columns: ["Package"] })))
    .then(() =>
      rValues(
        `as.vector(unserialize(readBin(${JSON.stringify(RDS_PATH)}, "raw", n = file.size(${JSON.stringify(RDS_PATH)}))))`
      )
    )
    .then((values) => assert.deepEqual(values, ["abc", "xyz"]));
});
