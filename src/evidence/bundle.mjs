import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import stableStringify from "json-stable-stringify";

import { UsageError } from "../errors.mjs";
import { BUNDLE_LAYOUT, runDirFor, sanitizeSegment } from "./paths.mjs";

const RUN_ID_RE = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;

function toBuffer(data) {
  if (typeof data === "string" || data instanceof Uint8Array) {
    return Buffer.from(data);
  }

  throw new UsageError("E_BAD_ARTIFACT_DATA", "Artifact data must be a string or Uint8Array", {
    reason: "unsupported_data_type"
  });
}

function toForwardSlash(segments) {
  return segments.join("/");
}

function splitRelativePath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new UsageError("E_BAD_ARTIFACT_PATH", "Artifact path must be a non empty string", {
      reason: "empty_path"
    });
  }

  if (path.isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new UsageError("E_BAD_ARTIFACT_PATH", "Artifact path must be relative", {
      path: relPath
    });
  }

  return relPath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => sanitizeSegment(segment));
}

function assertContained(runDir, resolvedPath, relPath) {
  const relative = path.relative(runDir, resolvedPath);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError("E_BAD_ARTIFACT_PATH", "Artifact path escapes the run directory", {
      path: relPath
    });
  }
}

function artifactKind(relPath) {
  const ext = path.posix.extname(relPath).slice(1).toLowerCase();
  return ext.length > 0 ? ext : "artifact";
}

function stableJson(value) {
  const json = stableStringify(value, { space: 2 });

  if (typeof json !== "string") {
    throw new UsageError("E_BAD_ARTIFACT_JSON", "Artifact JSON value is not serializable", {
      reason: "json_stringify_returned_empty"
    });
  }

  return `${json}\n`;
}

function basicUtc(date) {
  return date.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function generateRunId(now) {
  if (typeof now !== "function") {
    throw new UsageError("E_BAD_RUN_ID", "A clock function is required when runId is omitted", {
      reason: "missing_clock"
    });
  }

  const date = now();

  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new UsageError("E_BAD_RUN_ID", "Clock function must return a valid Date", {
      reason: "invalid_clock_value"
    });
  }

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toLowerCase();
  return `${basicUtc(date)}-${suffix}`;
}

function validateRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new UsageError("E_BAD_RUN_ID", "Run id must use the Attest run id format", {
      runId
    });
  }
}

export async function createBundle({ root, runId, now } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new UsageError("E_BAD_ARTIFACT_ROOT", "Artifact root must be a non empty string", {
      reason: "root_required"
    });
  }

  const bundleRunId = runId ?? generateRunId(now);
  validateRunId(bundleRunId);

  const dir = runDirFor(root, bundleRunId);
  const artifacts = [];
  const writtenPaths = new Set();

  await mkdir(dir, { recursive: true });

  async function writeFromSegments(segments, data) {
    const relPath = toForwardSlash(segments);
    const resolvedPath = path.resolve(dir, ...segments);
    assertContained(dir, resolvedPath, relPath);

    if (writtenPaths.has(relPath)) {
      throw new UsageError("E_DUPLICATE_ARTIFACT", "Artifact path was already written", {
        path: relPath
      });
    }

    const bytes = toBuffer(data);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, bytes);

    const ref = Object.freeze({
      kind: artifactKind(relPath),
      path: relPath,
      bytes: bytes.byteLength,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex")
    });

    writtenPaths.add(relPath);
    artifacts.push(ref);
    return ref;
  }

  async function write(relPath, data) {
    return writeFromSegments(splitRelativePath(relPath), data);
  }

  async function writeJson(relPath, value) {
    return write(relPath, stableJson(value));
  }

  function manifest() {
    return Object.freeze(artifacts.map((artifact) => Object.freeze({ ...artifact })));
  }

  async function finalize() {
    await writeFromSegments([BUNDLE_LAYOUT.manifest], stableJson(manifest()));
    return Object.freeze({
      dir,
      artifacts: manifest()
    });
  }

  function scenario(scenarioId, surface) {
    const baseSegments = [
      BUNDLE_LAYOUT.scenarios,
      `${sanitizeSegment(scenarioId)}__${sanitizeSegment(surface)}`
    ];
    const scenarioDir = path.join(dir, ...baseSegments);
    const scenarioWrite = (relPath, data) =>
      writeFromSegments([...baseSegments, ...splitRelativePath(relPath)], data);

    return Object.freeze({
      dir: scenarioDir,
      ref(relPath) {
        const segments = [...baseSegments, ...splitRelativePath(relPath)];
        return toForwardSlash(segments);
      },
      write: scenarioWrite,
      writeJson: (relPath, value) => scenarioWrite(relPath, stableJson(value))
    });
  }

  return Object.freeze({
    runId: bundleRunId,
    dir,
    scenario,
    write,
    writeJson,
    manifest,
    finalize
  });
}
