import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { readZipEntries, writeZip } from "../../evidence/zip.mjs";

const EVIDENCE_DIR = "evidence";
const TRACE_ARTIFACT = `${EVIDENCE_DIR}/trace.zip`;
const TEXT_ENTRY_RE = /\.(?:trace|network|jsonl?|txt|md)$/i;
const UTF8_PROBE_BYTES = 1024;
const REDACTED_HEADER_NAME = "redacted-header";
const SENSITIVE_HEADER_NAME_RE = /\b(?:authorization|cookie|set-cookie|apikey)\b/gi;

const decoder = new TextDecoder("utf-8", { fatal: true });

function isObject(value) {
  return value !== null && typeof value === "object";
}

function bundleFor(session) {
  return isObject(session?.bundle) && typeof session.bundle.write === "function"
    ? session.bundle
    : null;
}

function redactorFor(session) {
  const redactor = session?.redactor;
  if (isObject(redactor) && typeof redactor.redactText === "function") {
    return redactor;
  }

  return null;
}

function tracingFor(session) {
  const tracing = session?.context?.tracing;
  return isObject(tracing) && typeof tracing.stop === "function" ? tracing : null;
}

async function removePath(targetPath) {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    return;
  }

  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch {
    // Trace cleanup is best effort and must not hide the scenario result.
  }
}

async function recordTraceFailure(session, error) {
  const bundle = bundleFor(session);
  if (bundle === null || typeof bundle.writeJson !== "function") {
    return null;
  }

  const redactor = redactorFor(session);
  const rawReason = error instanceof Error ? error.message : String(error);
  const reason = redactor === null ? rawReason : redactor.redactText(rawReason);

  try {
    return await bundle.writeJson(`${EVIDENCE_DIR}/trace-error.json`, {
      reason
    });
  } catch {
    return null;
  }
}

function traceFailure(error) {
  return Object.freeze({
    ok: false,
    reason: error instanceof Error ? error.message : String(error)
  });
}

function tempTracePath(session) {
  const baseDir =
    typeof session?.tracesDir === "string" && session.tracesDir.length > 0
      ? session.tracesDir
      : bundleFor(session)?.dir;

  if (typeof baseDir !== "string" || baseDir.length === 0) {
    return null;
  }

  return path.join(baseDir, `trace-${randomUUID()}.zip`);
}

function isUtf8(bytes) {
  try {
    decoder.decode(bytes.subarray(0, Math.min(bytes.byteLength, UTF8_PROBE_BYTES)));
    return true;
  } catch {
    return false;
  }
}

function isTextEntry(entry) {
  return TEXT_ENTRY_RE.test(entry.name) || isUtf8(entry.data);
}

function redactHeaderNames(text) {
  return text.replace(SENSITIVE_HEADER_NAME_RE, REDACTED_HEADER_NAME);
}

function redactLineByLine(text, redactor) {
  let changed = false;
  let output = "";
  let start = 0;

  while (start < text.length) {
    const nextLineFeed = text.indexOf("\n", start);
    const end = nextLineFeed === -1 ? text.length : nextLineFeed + 1;
    const line = text.slice(start, end);
    const redacted = redactHeaderNames(redactor.redactText(line));
    changed ||= redacted !== line;
    output += redacted;
    start = end;
  }

  if (text.length === 0) {
    return Object.freeze({ changed: false, text });
  }

  return Object.freeze({
    changed,
    text: changed ? output : text
  });
}

function redactEntry(entry, redactor) {
  if (!isTextEntry(entry)) {
    return Object.freeze({ changed: false, entry });
  }

  const text = entry.data.toString("utf8");
  const redacted = redactLineByLine(text, redactor);
  if (!redacted.changed) {
    return Object.freeze({ changed: false, entry });
  }

  return Object.freeze({
    changed: true,
    entry: Object.freeze({
      name: entry.name,
      data: Buffer.from(redacted.text, "utf8")
    })
  });
}

export function redactTraceBuffer(buffer, redactor) {
  if (!isObject(redactor) || typeof redactor.redactText !== "function") {
    throw new TypeError("redactTraceBuffer requires a redactor with redactText");
  }

  const entries = readZipEntries(buffer);
  const redacted = entries.map((entry) => redactEntry(entry, redactor));
  if (!redacted.some((entry) => entry.changed)) {
    return buffer;
  }

  return writeZip(redacted.map((entry) => entry.entry));
}

export async function retainTrace(session) {
  const tracing = tracingFor(session);
  const bundle = bundleFor(session);
  const redactor = redactorFor(session);
  const targetPath = tempTracePath(session);

  if (tracing === null || bundle === null || redactor === null || targetPath === null) {
    return Object.freeze({ ok: false, reason: "trace prerequisites are missing" });
  }

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await tracing.stop({ path: targetPath });
    const original = await readFile(targetPath);
    const redacted = redactTraceBuffer(original, redactor);
    const ref = await bundle.write(TRACE_ARTIFACT, redacted);
    return Object.freeze({ ok: true, artifact: ref });
  } catch (error) {
    await recordTraceFailure(session, error);
    return traceFailure(error);
  } finally {
    await removePath(targetPath);
    await removePath(session?.tracesDir);
  }
}

export async function discardTrace(session) {
  const tracing = tracingFor(session);

  try {
    if (tracing !== null) {
      await tracing.stop();
    }
    return Object.freeze({ ok: true });
  } catch (error) {
    return traceFailure(error);
  } finally {
    await removePath(session?.tracesDir);
  }
}
