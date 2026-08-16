import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const INLINE_BYTE_LIMIT = Object.freeze(4 * 1024 * 1024);

const IMAGE_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp"
});

const HTML_ENTITIES = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
});

const HTML_ESCAPE_RE = /[&<>"']/g;
const DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function asText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

export function escapeHtml(value) {
  return asText(value).replaceAll(HTML_ESCAPE_RE, (char) => HTML_ENTITIES[char]);
}

function toSafeRelativePath(ref) {
  const relPath = ref?.path;

  if (typeof relPath !== "string" || relPath.length === 0) {
    return null;
  }

  if (
    relPath.includes("\\") ||
    relPath.startsWith("/") ||
    path.isAbsolute(relPath) ||
    DRIVE_PATH_RE.test(relPath) ||
    SCHEME_RE.test(relPath)
  ) {
    return null;
  }

  return relPath;
}

function resolveArtifactPath(artifactDir, relPath) {
  if (typeof artifactDir !== "string" || artifactDir.length === 0) {
    return null;
  }

  const base = path.resolve(artifactDir);
  const resolved = path.resolve(base, ...relPath.split("/"));
  const relative = path.relative(base, resolved);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return { base, resolved };
}

function contentTypeFor(relPath) {
  const ext = path.posix.extname(relPath).slice(1).toLowerCase();
  return IMAGE_TYPES[ext] ?? null;
}

function link(relPath) {
  return Object.freeze({ mode: "link", href: relPath });
}

function missing() {
  return Object.freeze({ mode: "missing" });
}

function artifactSize(resolved) {
  try {
    const info = statSync(resolved);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

export function inlineArtifact({ artifactDir, ref } = {}) {
  const relPath = toSafeRelativePath(ref);
  if (relPath === null) {
    return missing();
  }

  const resolved = resolveArtifactPath(artifactDir, relPath);
  if (resolved === null) {
    return missing();
  }

  const size = artifactSize(resolved.resolved);
  if (size === null) {
    return missing();
  }

  const contentType = contentTypeFor(relPath);
  if (contentType === null || size > INLINE_BYTE_LIMIT) {
    return link(relPath);
  }

  try {
    const bytes = readFileSync(resolved.resolved);
    return Object.freeze({
      mode: "inline",
      src: `data:${contentType};base64,${bytes.toString("base64")}`
    });
  } catch {
    return missing();
  }
}
