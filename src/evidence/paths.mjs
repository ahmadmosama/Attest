import crypto from "node:crypto";
import path from "node:path";

import { UsageError } from "../errors.mjs";

export const BUNDLE_LAYOUT = Object.freeze({
  runRecord: "run.json",
  junit: "junit.xml",
  manifest: "manifest.json",
  scenarios: "scenarios",
  plan: "plan.json",
  steps: "steps"
});

const MAX_SEGMENT_LENGTH = 100;
const HASH_SUFFIX_LENGTH = 7;
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const DRIVE_RE = /^[A-Za-z]:/;

function shortHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 6);
}

function hasSurvivingCharacters(value) {
  return /[A-Za-z0-9._-]/.test(value);
}

export function sanitizeSegment(raw) {
  if (typeof raw !== "string") {
    throw new UsageError("E_BAD_PATH_SEGMENT", "Path segment must be a string", {
      reason: "segment_not_string"
    });
  }

  if (!hasSurvivingCharacters(raw)) {
    throw new UsageError("E_BAD_PATH_SEGMENT", "Path segment cannot be empty", {
      reason: "empty_after_sanitize"
    });
  }

  const withoutDrive = raw.replace(DRIVE_RE, "");
  let segment = withoutDrive
    .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
    .replaceAll(/_+/g, "_")
    .replaceAll(/\.\.+/g, ".")
    .replaceAll(/^\.+/g, "")
    .replaceAll(/^_+|_+$/g, "");

  if (segment.length === 0) {
    throw new UsageError("E_BAD_PATH_SEGMENT", "Path segment cannot be empty", {
      reason: "empty_after_sanitize"
    });
  }

  if (WINDOWS_DEVICE_RE.test(segment)) {
    segment = `_${segment}`;
  }

  if (segment.length > MAX_SEGMENT_LENGTH) {
    const keepLength = MAX_SEGMENT_LENGTH - HASH_SUFFIX_LENGTH;
    segment = `${segment.slice(0, keepLength)}-${shortHash(raw)}`;
  }

  return segment;
}

export function runDirFor(root, runId) {
  return path.join(root, sanitizeSegment(runId));
}

export function scenarioDirFor(runDir, scenarioId, surface) {
  const scenarioSegment = `${sanitizeSegment(scenarioId)}__${sanitizeSegment(surface)}`;
  return path.join(runDir, BUNDLE_LAYOUT.scenarios, scenarioSegment);
}
