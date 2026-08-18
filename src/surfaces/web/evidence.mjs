import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const EVIDENCE_DIR = "evidence";
const DEFAULT_SCREENSHOT_FULL_PAGE = true;

function isObject(value) {
  return value !== null && typeof value === "object";
}

function bundleFor(session) {
  return isObject(session?.bundle) && typeof session.bundle.write === "function"
    ? session.bundle
    : null;
}

function pageFor(session) {
  return isObject(session?.page) ? session.page : null;
}

function redactorFor(session) {
  const redactor = session?.redactor;
  if (
    isObject(redactor) &&
    typeof redactor.redactText === "function" &&
    typeof redactor.redactValue === "function"
  ) {
    return redactor;
  }

  return null;
}

function redactText(session, value) {
  const text = String(value ?? "");
  const redactor = redactorFor(session);
  if (redactor === null) {
    return text;
  }

  try {
    return redactor.redactText(text);
  } catch {
    return "[REDACTED]";
  }
}

function redactValue(session, value) {
  const redactor = redactorFor(session);
  if (redactor === null) {
    return value;
  }

  try {
    return redactor.redactValue(value);
  } catch {
    return "[REDACTED]";
  }
}

function safeName(session, name) {
  const redacted = redactText(session, name);
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

function jsonLine(session, value) {
  return `${JSON.stringify(redactValue(session, value))}\n`;
}

function networkEntries(session) {
  if (typeof session?.network?.entries !== "function") {
    return Object.freeze([]);
  }

  const entries = session.network.entries();
  return Array.isArray(entries) ? entries : Object.freeze([]);
}

async function removePath(targetPath) {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    return;
  }

  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch {
    // Evidence cleanup is best effort and must not hide the scenario result.
  }
}

async function closePageForVideo(session) {
  const page = pageFor(session);
  if (typeof page?.close !== "function") {
    return;
  }

  try {
    await page.close();
  } catch {
    // A page may already be closed after a browser failure.
  }
}

function videoFor(session) {
  const page = pageFor(session);
  if (typeof page?.video !== "function") {
    return null;
  }

  try {
    return page.video();
  } catch {
    return null;
  }
}

function tempVideoPath(session) {
  const dir =
    typeof session?.videoDir === "string" && session.videoDir.length > 0
      ? session.videoDir
      : bundleFor(session)?.dir;

  if (typeof dir !== "string" || dir.length === 0) {
    return null;
  }

  return path.join(dir, `retained-${randomUUID()}.webm`);
}

/**
 * Record why a screenshot is missing, next to where it would have been.
 *
 * Capture must never fail a scenario: a passing run whose screenshot did not
 * write is still a passing run, and the alternative is evidence collection
 * deciding verdicts. But a bare `catch {}` makes a SYSTEMATIC failure look
 * exactly like "no checkpoint in this scenario", which is how a screenshot that
 * has not worked on one host for weeks goes unnoticed.
 *
 * Same shape the trace layer already uses for the same reason.
 */
async function recordCaptureFailure(session, name, error) {
  const bundle = session?.bundle ?? null;
  if (bundle === null || typeof bundle.writeJson !== "function") {
    return null;
  }

  const raw = error instanceof Error ? error.message : String(error);
  const redactor = session?.redactor ?? null;

  try {
    return await bundle.writeJson(`${EVIDENCE_DIR}/${safeName(session, name)}-error.json`, {
      reason: typeof redactor?.redactText === "function" ? redactor.redactText(raw) : raw
    });
  } catch {
    return null;
  }
}

export async function captureScreenshot(
  session,
  { name, fullPage = DEFAULT_SCREENSHOT_FULL_PAGE } = {}
) {
  const page = pageFor(session);
  if (typeof page?.screenshot !== "function") {
    return null;
  }

  let lastError = null;

  // fullPage first, then the viewport. `fullPage` has to settle the whole
  // scrollable document, and on a slow host against a live remote page that is
  // the part that times out. A viewport screenshot of the failing step is worth
  // far more than no evidence at all, so the fallback is a real attempt rather
  // than a formality.
  const attempts = Boolean(fullPage) ? [{ fullPage: true }, { fullPage: false }] : [{ fullPage: false }];

  for (const options of attempts) {
    try {
      const bytes = await page.screenshot(options);
      return await writeBundle(session, `${EVIDENCE_DIR}/${safeName(session, name)}.png`, bytes);
    } catch (error) {
      lastError = error;
    }
  }

  await recordCaptureFailure(session, name, lastError);
  return null;
}

export async function writeNetworkLog(session) {
  try {
    const lines = networkEntries(session)
      .map((entry) => jsonLine(session, entry))
      .join("");
    const truncated =
      typeof session?.network?.truncated === "function" ? session.network.truncated() : 0;
    const content =
      truncated > 0
        ? `${lines}${jsonLine(session, { truncated })}`
        : lines;

    return await writeBundle(session, `${EVIDENCE_DIR}/network.jsonl`, content);
  } catch {
    return null;
  }
}

export async function retainVideo(session) {
  let retainedPath = null;

  try {
    const video = videoFor(session);
    if (video === null || typeof video.saveAs !== "function") {
      return null;
    }

    retainedPath = tempVideoPath(session);
    if (retainedPath === null) {
      return null;
    }

    await mkdir(path.dirname(retainedPath), { recursive: true });
    await closePageForVideo(session);
    await video.saveAs(retainedPath);
    const bytes = await readFile(retainedPath);
    return await writeBundle(session, `${EVIDENCE_DIR}/video.webm`, bytes);
  } catch {
    return null;
  } finally {
    await removePath(retainedPath);
  }
}

export async function discardVideo(session) {
  try {
    const video = videoFor(session);
    await closePageForVideo(session);
    if (video !== null && typeof video.delete === "function") {
      await video.delete();
    }
  } catch {
    // Video discard is best effort. The adapter removes temp dirs afterwards.
  }

  return null;
}
