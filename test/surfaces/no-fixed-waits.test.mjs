import assert from "node:assert/strict";
import { opendir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SOURCE_ROOT = path.resolve("src");
const CONVERGE_FILE = path.resolve("src/runtime/converge.mjs");

async function sourceFiles(dir) {
  const entries = [];
  const handle = await opendir(dir);

  for await (const entry of handle) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await sourceFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      entries.push(fullPath);
    }
  }

  return entries;
}

function stripQuotedText(line) {
  let output = "";
  let quote = null;
  let escaped = false;

  for (const char of line) {
    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    output += char;
  }

  return output;
}

function searchableLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
    return "";
  }

  return stripQuotedText(line);
}

function fixedWaitOffenses(filePath, source) {
  const offenses = [];
  const lines = source.split(/\r?\n/u);
  const isConverge = path.resolve(filePath) === CONVERGE_FILE;

  lines.forEach((line, index) => {
    const searchable = searchableLine(line);
    if (searchable.length === 0) {
      return;
    }

    if (/\bwaitForTimeout\b/u.test(searchable)) {
      offenses.push({ filePath, line: index + 1, pattern: "waitForTimeout" });
    }

    if (!isConverge && /\bsetTimeout\(\s*[^,]+,\s*\d{3,}\)/u.test(searchable)) {
      offenses.push({ filePath, line: index + 1, pattern: "setTimeout fixed wait" });
    }

    if (/(^|[^\w$])sleep([^\w$]|$)/u.test(searchable)) {
      offenses.push({ filePath, line: index + 1, pattern: "sleep identifier" });
    }
  });

  return offenses;
}

test("source tree contains no fixed waits", async () => {
  const files = await sourceFiles(SOURCE_ROOT);
  const offenses = [];

  for (const filePath of files) {
    offenses.push(...fixedWaitOffenses(filePath, await readFile(filePath, "utf8")));
  }

  assert.equal(
    offenses.length,
    0,
    offenses
      .map((offense) => `${path.relative(process.cwd(), offense.filePath)}:${offense.line} ${offense.pattern}`)
      .join("\n")
  );
});
