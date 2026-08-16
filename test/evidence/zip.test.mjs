import assert from "node:assert/strict";
import zlib from "node:zlib";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import { readZipEntries, writeZip } from "../../src/evidence/zip.mjs";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const DOS_DATE_1980_01_01 = 0x0021;

function storedZip(name, data, method = 0) {
  const nameBytes = Buffer.from(name, "utf8");
  const bytes = Buffer.from(data);
  const payload = method === 0 ? bytes : Buffer.from("unsupported");
  const crc32 = zlib.crc32(bytes) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
  local.writeUInt32LE(crc32, 14);
  local.writeUInt32LE(payload.byteLength, 18);
  local.writeUInt32LE(bytes.byteLength, 22);
  local.writeUInt16LE(nameBytes.byteLength, 26);
  local.writeUInt16LE(0, 28);

  const centralOffset = local.byteLength + nameBytes.byteLength + payload.byteLength;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
  central.writeUInt32LE(crc32, 16);
  central.writeUInt32LE(payload.byteLength, 20);
  central.writeUInt32LE(bytes.byteLength, 24);
  central.writeUInt16LE(nameBytes.byteLength, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.byteLength + nameBytes.byteLength, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBytes, payload, central, nameBytes, eocd]);
}

function plainEntries(entries) {
  return entries.map((entry) => ({
    name: entry.name,
    text: entry.data.toString("utf8")
  }));
}

test("writeZip produces a readable deflated archive for one entry", () => {
  const zip = writeZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  const entries = readZipEntries(zip);

  assert.deepEqual(plainEntries(entries), [{ name: "a.txt", text: "hello" }]);
});

test("a round trip of three entries preserves order, names, and contents", () => {
  const source = [
    { name: "first.txt", data: Buffer.from("one") },
    { name: "nested/second.json", data: Buffer.from("{\"two\":2}") },
    { name: "third.bin", data: Buffer.from([0, 1, 2, 3]) }
  ];

  const entries = readZipEntries(writeZip(source));

  assert.deepEqual(entries.map((entry) => entry.name), source.map((entry) => entry.name));
  assert.deepEqual(entries.map((entry) => entry.data), source.map((entry) => entry.data));
});

test("readZipEntries passes through STORED entries", () => {
  const entries = readZipEntries(storedZip("stored/path.txt", Buffer.from("stored bytes")));

  assert.deepEqual(plainEntries(entries), [{ name: "stored/path.txt", text: "stored bytes" }]);
});

test("readZipEntries rejects a buffer with no end of central directory record", () => {
  assert.throws(
    () => readZipEntries(Buffer.from("not a zip")),
    (error) => error instanceof AttestError && error.code === "E_ZIP_EOCD_MISSING"
  );
});

test("zero byte entries round trip", () => {
  const entries = readZipEntries(writeZip([{ name: "empty.txt", data: Buffer.alloc(0) }]));

  assert.equal(entries[0].name, "empty.txt");
  assert.equal(entries[0].data.byteLength, 0);
});

test("large repetitive entries are deflated and round trip", () => {
  const text = "same line\n".repeat(140000);
  const zip = writeZip([{ name: "large.txt", data: Buffer.from(text) }]);
  const entries = readZipEntries(zip);

  assert.equal(entries[0].data.toString("utf8"), text);
  assert(zip.byteLength < Buffer.byteLength(text));
});

test("readZipEntries refuses entries over the configured ceiling", () => {
  const zip = writeZip([{ name: "too-large.txt", data: Buffer.from("0123456789") }]);

  assert.throws(
    () => readZipEntries(zip, { maxEntryBytes: 5 }),
    (error) => error instanceof AttestError && error.code === "E_ZIP_ENTRY_TOO_LARGE"
  );
});

test("unsupported compression methods throw a named error", () => {
  assert.throws(
    () => readZipEntries(storedZip("bad.txt", Buffer.from("bad"), 12)),
    (error) => error instanceof AttestError && error.code === "E_ZIP_UNSUPPORTED_METHOD"
  );
});
