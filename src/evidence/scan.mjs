import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { readZipEntries } from "./zip.mjs";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const PREVIEW_RADIUS = 28;

export const DEFAULT_FORBIDDEN_PATTERNS = Object.freeze([
  /Authorization/i,
  /Cookie/i,
  /Set-Cookie/i,
  /apikey/i
]);

function normalizeMaxFileBytes(maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) {
    throw new TypeError("maxFileBytes must be a non negative safe integer");
  }

  return maxFileBytes;
}

function toForwardSlash(value) {
  return value.split(path.sep).join("/");
}

function relativePath(rootDir, filePath) {
  return toForwardSlash(path.relative(rootDir, filePath));
}

function escapeRegex(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternChecks(patterns = [], literals = []) {
  if (!Array.isArray(patterns) || !Array.isArray(literals)) {
    throw new TypeError("patterns and literals must be arrays");
  }

  const regexChecks = patterns.map((pattern) => {
    if (pattern instanceof RegExp) {
      const flags = pattern.flags.replaceAll("g", "").replaceAll("y", "");
      return Object.freeze({
        label: pattern.source,
        regex: new RegExp(pattern.source, flags)
      });
    }

    if (typeof pattern === "string" && pattern.length > 0) {
      return Object.freeze({
        label: pattern,
        regex: new RegExp(escapeRegex(pattern), "i")
      });
    }

    throw new TypeError("patterns must contain RegExp objects or non empty strings");
  });

  const literalChecks = literals.map((literal) => {
    if (typeof literal !== "string" || literal.length === 0) {
      throw new TypeError("literals must contain non empty strings");
    }

    return Object.freeze({
      label: "literal",
      regex: new RegExp(escapeRegex(literal), "g")
    });
  });

  return Object.freeze([...regexChecks, ...literalChecks]);
}

async function walkFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(rootDir, entryPath);
      }

      if (entry.isFile()) {
        return [entryPath];
      }

      return [];
    })
  );

  return results.flat().toSorted();
}

function lineForIndex(text, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 10) {
      line += 1;
    }
  }

  return line;
}

function maskedPreview(text, match) {
  const start = Math.max(0, match.index - PREVIEW_RADIUS);
  const end = Math.min(text.length, match.index + match[0].length + PREVIEW_RADIUS);
  return `${text.slice(start, match.index)}[MATCH]${text.slice(match.index + match[0].length, end)}`
    .replaceAll(/\r?\n/g, "\\n")
    .slice(0, PREVIEW_RADIUS * 2 + 16);
}

function finding({ relPath, entry = undefined, line = null, pattern, preview }) {
  return Object.freeze({
    path: relPath,
    entry,
    line,
    pattern,
    preview
  });
}

function unscannedFinding(relPath, preview, entry = undefined) {
  return finding({
    relPath,
    entry,
    pattern: "UNSCANNED",
    preview
  });
}

function scanTextContent({ relPath, entry, text, checks, withLineNumbers }) {
  const findings = [];

  for (const check of checks) {
    check.regex.lastIndex = 0;
    const match = check.regex.exec(text);
    if (match === null) {
      continue;
    }

    findings.push(
      finding({
        relPath,
        entry,
        line: withLineNumbers ? lineForIndex(text, match.index) : null,
        pattern: check.label,
        preview: maskedPreview(text, match)
      })
    );
  }

  return findings;
}

function isLikelyTextPath(filePath) {
  return /\.(?:css|csv|html?|js|json|jsonl|md|mjs|network|trace|txt|xml|yaml|yml)$/i.test(filePath);
}

function scanBytes({ relPath, entry, bytes, checks, sourcePath }) {
  const text = bytes.toString("utf8");
  return scanTextContent({
    relPath,
    entry,
    text,
    checks,
    withLineNumbers: isLikelyTextPath(sourcePath)
  });
}

async function scanZipFile({ rootDir, filePath, checks, maxFileBytes }) {
  const relPath = relativePath(rootDir, filePath);
  const bytes = await readFile(filePath);

  try {
    return readZipEntries(bytes, { maxEntryBytes: maxFileBytes }).flatMap((entry) =>
      scanBytes({
        relPath,
        entry: entry.name,
        bytes: entry.data,
        checks,
        sourcePath: entry.name
      })
    );
  } catch (error) {
    return [
      unscannedFinding(
        relPath,
        error instanceof Error ? error.message : "zip archive could not be scanned"
      )
    ];
  }
}

async function scanFile({ rootDir, filePath, checks, maxFileBytes }) {
  const relPath = relativePath(rootDir, filePath);
  const details = await stat(filePath);
  if (details.size > maxFileBytes) {
    return [unscannedFinding(relPath, `file is ${details.size} bytes, max is ${maxFileBytes}`)];
  }

  if (path.extname(filePath).toLowerCase() === ".zip") {
    return scanZipFile({ rootDir, filePath, checks, maxFileBytes });
  }

  const bytes = await readFile(filePath);
  return scanBytes({ relPath, bytes, checks, sourcePath: filePath });
}

export async function scanBundleForSecrets(
  dir,
  { patterns = DEFAULT_FORBIDDEN_PATTERNS, literals = [], maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}
) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("dir must be a non empty string");
  }

  const rootDir = path.resolve(dir);
  const checks = patternChecks(patterns, literals);
  const fileLimit = normalizeMaxFileBytes(maxFileBytes);
  const files = await walkFiles(rootDir);
  const findings = await Promise.all(
    files.map((filePath) => scanFile({ rootDir, filePath, checks, maxFileBytes: fileLimit }))
  );

  return Object.freeze(findings.flat());
}
