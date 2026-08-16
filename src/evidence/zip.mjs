import zlib from "node:zlib";

import { AttestError } from "../errors.mjs";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const ZIP_COMMENT_MAX_BYTES = 0xffff;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const DOS_DATE_1980_01_01 = 0x0021;

function zipError(code, message, details = {}) {
  return new AttestError(code, message, details);
}

function toBuffer(buffer) {
  if (Buffer.isBuffer(buffer)) {
    return buffer;
  }

  if (buffer instanceof Uint8Array) {
    return Buffer.from(buffer);
  }

  throw new TypeError("zip buffer must be a Buffer or Uint8Array");
}

function entryDataBuffer(data) {
  if (typeof data === "string" || data instanceof Uint8Array) {
    return Buffer.from(data);
  }

  throw new TypeError("zip entry data must be a string or Uint8Array");
}

function normalizeMaxEntryBytes(maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES) {
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 0) {
    throw new TypeError("maxEntryBytes must be a non negative safe integer");
  }

  return maxEntryBytes;
}

function assertRange(buffer, offset, bytes, code, details = {}) {
  if (offset < 0 || bytes < 0 || offset + bytes > buffer.length) {
    throw zipError(code, "Zip record is outside the archive bounds", {
      offset,
      bytes,
      archiveBytes: buffer.length,
      ...details
    });
  }
}

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - EOCD_BYTES - ZIP_COMMENT_MAX_BYTES);

  for (let offset = buffer.length - EOCD_BYTES; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }

    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_BYTES + commentLength === buffer.length) {
      return offset;
    }
  }

  throw zipError("E_ZIP_EOCD_MISSING", "Zip archive has no end of central directory record");
}

function readEndOfCentralDirectory(buffer) {
  const offset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(offset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(offset + 6);
  const entriesOnDisk = buffer.readUInt16LE(offset + 8);
  const entryCount = buffer.readUInt16LE(offset + 10);
  const centralDirectoryBytes = buffer.readUInt32LE(offset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(offset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw zipError("E_ZIP_MULTIDISK_UNSUPPORTED", "Multi disk zip archives are not supported", {
      diskNumber,
      centralDirectoryDisk,
      entriesOnDisk,
      entryCount
    });
  }

  if (
    entryCount === UINT16_MAX ||
    centralDirectoryBytes === UINT32_MAX ||
    centralDirectoryOffset === UINT32_MAX
  ) {
    throw zipError("E_ZIP64_UNSUPPORTED", "Zip64 archives are not supported");
  }

  assertRange(
    buffer,
    centralDirectoryOffset,
    centralDirectoryBytes,
    "E_ZIP_CENTRAL_DIRECTORY_OUT_OF_BOUNDS"
  );

  return Object.freeze({
    entryCount,
    centralDirectoryBytes,
    centralDirectoryOffset
  });
}

function readCentralRecord(buffer, offset) {
  assertRange(buffer, offset, CENTRAL_HEADER_BYTES, "E_ZIP_CENTRAL_DIRECTORY_TRUNCATED");
  if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
    throw zipError("E_ZIP_CENTRAL_DIRECTORY_INVALID", "Invalid zip central directory record", {
      offset
    });
  }

  const flags = buffer.readUInt16LE(offset + 8);
  const method = buffer.readUInt16LE(offset + 10);
  const crc32 = buffer.readUInt32LE(offset + 16);
  const compressedBytes = buffer.readUInt32LE(offset + 20);
  const uncompressedBytes = buffer.readUInt32LE(offset + 24);
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  const localHeaderOffset = buffer.readUInt32LE(offset + 42);
  const nameStart = offset + CENTRAL_HEADER_BYTES;
  const nameEnd = nameStart + nameLength;
  const nextOffset = nameEnd + extraLength + commentLength;

  assertRange(buffer, nameStart, nameLength, "E_ZIP_CENTRAL_DIRECTORY_TRUNCATED", { offset });
  assertRange(buffer, nextOffset, 0, "E_ZIP_CENTRAL_DIRECTORY_TRUNCATED", { offset });

  if ((flags & 0x0001) !== 0) {
    throw zipError("E_ZIP_ENCRYPTED_UNSUPPORTED", "Encrypted zip entries are not supported", {
      name: buffer.subarray(nameStart, nameEnd).toString("utf8")
    });
  }

  return Object.freeze({
    name: buffer.subarray(nameStart, nameEnd).toString("utf8"),
    flags,
    method,
    crc32,
    compressedBytes,
    uncompressedBytes,
    localHeaderOffset,
    nextOffset
  });
}

function readLocalPayload(buffer, record) {
  assertRange(buffer, record.localHeaderOffset, LOCAL_HEADER_BYTES, "E_ZIP_LOCAL_HEADER_TRUNCATED", {
    name: record.name
  });
  if (buffer.readUInt32LE(record.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw zipError("E_ZIP_LOCAL_HEADER_INVALID", "Invalid zip local file header", {
      name: record.name,
      offset: record.localHeaderOffset
    });
  }

  const nameLength = buffer.readUInt16LE(record.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(record.localHeaderOffset + 28);
  const dataStart = record.localHeaderOffset + LOCAL_HEADER_BYTES + nameLength + extraLength;
  assertRange(buffer, dataStart, record.compressedBytes, "E_ZIP_ENTRY_OUT_OF_BOUNDS", {
    name: record.name
  });

  return buffer.subarray(dataStart, dataStart + record.compressedBytes);
}

function inflateEntry(payload, record) {
  if (record.method === METHOD_STORED) {
    return Buffer.from(payload);
  }

  if (record.method !== METHOD_DEFLATE) {
    throw zipError("E_ZIP_UNSUPPORTED_METHOD", "Unsupported zip compression method", {
      name: record.name,
      method: record.method
    });
  }

  try {
    return zlib.inflateRawSync(payload);
  } catch (error) {
    throw zipError("E_ZIP_INFLATE_FAILED", "Could not inflate zip entry", {
      name: record.name,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function verifyEntryData(record, data) {
  if (data.byteLength !== record.uncompressedBytes) {
    throw zipError("E_ZIP_SIZE_MISMATCH", "Zip entry inflated to an unexpected size", {
      name: record.name,
      declaredBytes: record.uncompressedBytes,
      actualBytes: data.byteLength
    });
  }

  const actualCrc32 = zlib.crc32(data) >>> 0;
  if (actualCrc32 !== record.crc32) {
    throw zipError("E_ZIP_CRC_MISMATCH", "Zip entry CRC does not match", {
      name: record.name
    });
  }
}

export function readZipEntries(buffer, { maxEntryBytes } = {}) {
  const archive = toBuffer(buffer);
  const entryLimit = normalizeMaxEntryBytes(maxEntryBytes);
  const eocd = readEndOfCentralDirectory(archive);
  const entries = [];
  let offset = eocd.centralDirectoryOffset;

  for (let index = 0; index < eocd.entryCount; index += 1) {
    const record = readCentralRecord(archive, offset);
    if (record.uncompressedBytes > entryLimit) {
      throw zipError("E_ZIP_ENTRY_TOO_LARGE", "Zip entry exceeds the configured size limit", {
        name: record.name,
        bytes: record.uncompressedBytes,
        maxEntryBytes: entryLimit
      });
    }

    const data = inflateEntry(readLocalPayload(archive, record), record);
    verifyEntryData(record, data);
    entries.push(Object.freeze({ name: record.name, data }));
    offset = record.nextOffset;
  }

  if (offset !== eocd.centralDirectoryOffset + eocd.centralDirectoryBytes) {
    throw zipError("E_ZIP_CENTRAL_DIRECTORY_SIZE_MISMATCH", "Zip central directory size mismatch");
  }

  return Object.freeze(entries);
}

function assertZip32(value, field, details = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw zipError("E_ZIP64_UNSUPPORTED", "Zip64 archives are not supported", {
      field,
      value,
      ...details
    });
  }
}

function assertZip16(value, field, details = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT16_MAX) {
    throw zipError("E_ZIP64_UNSUPPORTED", "Zip64 archives are not supported", {
      field,
      value,
      ...details
    });
  }
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("writeZip entries must be an array");
  }

  assertZip16(entries.length, "entryCount");
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new TypeError("zip entries must be objects");
    }

    if (typeof entry.name !== "string" || entry.name.length === 0) {
      throw new TypeError("zip entry names must be non empty strings");
    }

    const name = Buffer.from(entry.name, "utf8");
    assertZip16(name.byteLength, "nameBytes", { index });
    return Object.freeze({
      nameText: entry.name,
      name,
      data: entryDataBuffer(entry.data)
    });
  });
}

function localHeaderFor(entry, offset) {
  const compressed = zlib.deflateRawSync(entry.data);
  const crc32 = zlib.crc32(entry.data) >>> 0;
  assertZip32(compressed.byteLength, "compressedBytes", { name: entry.nameText });
  assertZip32(entry.data.byteLength, "uncompressedBytes", { name: entry.nameText });

  const header = Buffer.alloc(LOCAL_HEADER_BYTES);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(METHOD_DEFLATE, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 12);
  header.writeUInt32LE(crc32, 14);
  header.writeUInt32LE(compressed.byteLength, 18);
  header.writeUInt32LE(entry.data.byteLength, 22);
  header.writeUInt16LE(entry.name.byteLength, 26);
  header.writeUInt16LE(0, 28);

  return Object.freeze({
    local: Buffer.concat([header, entry.name, compressed]),
    compressedBytes: compressed.byteLength,
    crc32,
    offset,
    uncompressedBytes: entry.data.byteLength
  });
}

function centralHeaderFor(entry, written) {
  const header = Buffer.alloc(CENTRAL_HEADER_BYTES);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(METHOD_DEFLATE, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
  header.writeUInt32LE(written.crc32, 16);
  header.writeUInt32LE(written.compressedBytes, 20);
  header.writeUInt32LE(written.uncompressedBytes, 24);
  header.writeUInt16LE(entry.name.byteLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(written.offset, 42);

  return Buffer.concat([header, entry.name]);
}

function endOfCentralDirectory(entryCount, centralDirectoryBytes, centralDirectoryOffset) {
  const eocd = Buffer.alloc(EOCD_BYTES);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralDirectoryBytes, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

export function writeZip(entries) {
  const normalized = normalizeEntries(entries);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of normalized) {
    assertZip32(offset, "localHeaderOffset", { name: entry.nameText });
    const written = localHeaderFor(entry, offset);
    localParts.push(written.local);
    centralParts.push(centralHeaderFor(entry, written));
    offset += written.local.byteLength;
    assertZip32(offset, "archiveOffset", { name: entry.nameText });
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  assertZip32(centralDirectory.byteLength, "centralDirectoryBytes");
  assertZip32(centralDirectoryOffset + centralDirectory.byteLength + EOCD_BYTES, "archiveBytes");

  return Buffer.concat([
    ...localParts,
    centralDirectory,
    endOfCentralDirectory(normalized.length, centralDirectory.byteLength, centralDirectoryOffset)
  ]);
}
