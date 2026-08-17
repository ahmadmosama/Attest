import { Buffer } from "node:buffer";

import { ADB_COMMANDS, buildAdbCommand } from "./commands.mjs";
import { run } from "./session.mjs";

const EVIDENCE_DIR = "evidence";

// `adb screenrecord` refuses anything above 180 seconds. A longer scenario
// keeps the first 180 seconds and says so in the artifact detail. Silently
// losing the tail is the failure mode worth avoiding, not the ceiling.
export const MAX_RECORD_SECONDS = 180;

function bundleFor(session) {
  return session?.bundle !== null && typeof session?.bundle?.write === "function" ? session.bundle : null;
}

function safeName(session, name) {
  const redacted = session?.redactor?.redactText?.(String(name ?? "")) ?? String(name ?? "");
  const cleaned = redacted
    .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
    .replaceAll(/_+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 120);

  return cleaned.length > 0 ? cleaned : "artifact";
}

async function writeBundle(session, relPath, data) {
  const bundle = bundleFor(session);
  if (bundle === null) {
    return null;
  }

  return bundle.write(relPath, data);
}

function redactText(session, text) {
  try {
    return session?.redactor?.redactText?.(text) ?? text;
  } catch {
    return "[REDACTED]";
  }
}

/**
 * A PNG of the current screen, straight from stdout.
 *
 * `exec-out screencap -p` never touches a host path, which is what keeps the
 * MSYS path rewriting trap out of the evidence path.
 */
export async function captureScreenshot(session, { name, signal } = {}) {
  try {
    const result = await run(session, ADB_COMMANDS.screencap, {}, { signal, encoding: "buffer" });
    return await writeBundle(session, `${EVIDENCE_DIR}/${safeName(session, name)}.png`, result.stdout);
  } catch {
    // Evidence capture must never replace the real scenario result.
    return null;
  }
}

/**
 * The UI hierarchy at this moment, redacted before it reaches disk.
 *
 * The dump carries whatever text is on screen, which can include a token that
 * the app rendered. Redaction happens here, at capture time, exactly as the
 * web adapter redacts a HAR at capture time rather than at publication time.
 */
export async function captureHierarchy(session, { name = "hierarchy", signal } = {}) {
  try {
    await run(session, ADB_COMMANDS.uiDump, { devicePath: session.dumpPath }, { signal });
    // Bytes, not text, for the same reason dumpHierarchy reads bytes: captured
    // text is capped and a truncated dump is misleading evidence.
    const result = await run(session, ADB_COMMANDS.readFile, { devicePath: session.dumpPath }, {
      signal,
      encoding: "buffer"
    });
    const xml = redactText(session, result.stdout.toString("utf8"));
    return await writeBundle(session, `${EVIDENCE_DIR}/${safeName(session, name)}.xml`, xml);
  } catch {
    return null;
  }
}

/**
 * Start recording. Returns a handle, or null when recording is unavailable.
 */
export function startRecording(session) {
  try {
    const command = buildAdbCommand(
      ADB_COMMANDS.screenrecord,
      {
        serial: session.serial,
        devicePath: session.recordingPath,
        seconds: Math.min(session.recordSeconds ?? MAX_RECORD_SECONDS, MAX_RECORD_SECONDS)
      },
      { adbPath: session.adbPath }
    );

    return Object.freeze({
      child: session.runtime.startAdb(command),
      startedAt: Date.now()
    });
  } catch {
    return null;
  }
}

async function stopRecording(recording) {
  if (recording === null || recording === undefined) {
    return 0;
  }

  try {
    await recording.child.stop();
  } catch {
    // The recording may already have hit its own time limit.
  }

  return Math.max(0, Date.now() - recording.startedAt);
}

async function removeRecording(session, { signal } = {}) {
  try {
    await run(session, ADB_COMMANDS.removeFile, { devicePath: session.recordingPath }, { signal });
  } catch {
    // A device that has gone away cannot leak a file that matters.
  }
}

/**
 * Stop, pull and keep the recording. Used for a failed scenario.
 */
export async function retainRecording(session, recording, { signal } = {}) {
  const elapsedMs = await stopRecording(recording);

  if (recording === null || recording === undefined) {
    return null;
  }

  try {
    const result = await run(session, ADB_COMMANDS.readFile, { devicePath: session.recordingPath }, {
      signal,
      encoding: "buffer"
    });
    const bytes = Buffer.from(result.stdout ?? []);

    if (bytes.byteLength === 0) {
      return null;
    }

    const reference = await writeBundle(session, `${EVIDENCE_DIR}/recording.mp4`, bytes);
    if (reference === null) {
      return null;
    }

    return Object.freeze({
      ...reference,
      truncated: elapsedMs > MAX_RECORD_SECONDS * 1000,
      limitSeconds: MAX_RECORD_SECONDS
    });
  } catch {
    return null;
  } finally {
    await removeRecording(session, { signal });
  }
}

/**
 * Stop and throw the recording away. Used for a passing scenario.
 */
export async function discardRecording(session, recording, { signal } = {}) {
  await stopRecording(recording);
  await removeRecording(session, { signal });
  return null;
}

/**
 * Remove the hierarchy dump file this session wrote on the device.
 */
export async function removeDump(session, { signal } = {}) {
  try {
    await run(session, ADB_COMMANDS.removeFile, { devicePath: session.dumpPath }, { signal });
  } catch {
    // Best effort, same as every other close path.
  }
}
