import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LLM_PACKAGE_DENYLIST = Object.freeze([
  "@anthropic-ai/sdk",
  "openai",
  "@google/generative-ai",
  "@google/genai",
  "@mistralai/mistralai",
  "cohere-ai",
  "ollama",
  "langchain",
  "@langchain/core",
  "ai"
]);

export const DB_CLIENT_DENYLIST = Object.freeze(["@supabase/supabase-js"]);

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "fixtures"]);
const STATIC_FROM_RE = /^\s*(?:import|export)\s+[^"']*\sfrom\s*["']([^"']+)["']/;
const BARE_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/;
const DYNAMIC_IMPORT_RE = /^\s*(?:await\s+)?import\s*\(\s*["']([^"']+)["']\s*\)/;

function toForwardSlash(value) {
  return value.split(path.sep).join("/");
}

function relativePath(rootDir, filePath) {
  return toForwardSlash(path.relative(rootDir, filePath));
}

function isInside(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isDeniedLlmPackage(specifier) {
  return LLM_PACKAGE_DENYLIST.some(
    (denied) => specifier === denied || specifier.startsWith(`${denied}/`)
  );
}

function isDeniedDbClient(specifier) {
  return DB_CLIENT_DENYLIST.some(
    (denied) => specifier === denied || specifier.startsWith(`${denied}/`)
  );
}

function specifiersFromLine(line) {
  return [STATIC_FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]
    .map((regex) => regex.exec(line)?.[1])
    .filter((specifier) => typeof specifier === "string");
}

async function walkMjsFiles(rootDir, currentDir = rootDir) {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return {
      files: [],
      unreadableDirectories: [currentDir]
    };
  }

  const childResults = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
          return { files: [], unreadableDirectories: [] };
        }

        return walkMjsFiles(rootDir, entryPath);
      }

      if (entry.isFile() && entry.name.endsWith(".mjs")) {
        return { files: [entryPath], unreadableDirectories: [] };
      }

      return { files: [], unreadableDirectories: [] };
    })
  );

  return {
    files: childResults.flatMap((result) => result.files),
    unreadableDirectories: childResults.flatMap((result) => result.unreadableDirectories)
  };
}

function createGenerateViolation({ file, line, specifier, resolvedPath, rootDir, generateDir }) {
  return Object.freeze({
    file: relativePath(rootDir, file),
    line,
    specifier,
    rule: "no-generate-edge",
    reason: `${relativePath(rootDir, file)} imports ${relativePath(rootDir, resolvedPath)}. Runtime to ${relativePath(rootDir, generateDir)} is forbidden because this edge is the mechanical proof of RUN-02.`
  });
}

function createLlmViolation({ file, line, specifier, rootDir }) {
  return Object.freeze({
    file: relativePath(rootDir, file),
    line,
    specifier,
    rule: "no-llm-package",
    reason: `${specifier} is an LLM package and may only be imported from src/generate.`
  });
}

function createDbClientViolation({ file, line, specifier, rootDir }) {
  return Object.freeze({
    file: relativePath(rootDir, file),
    line,
    specifier,
    rule: "no-postgrest-db-client",
    reason: `${specifier} talks to PostgREST, and RLS can silently hide rows from the diff. That is disqualifying for an engine that must prove nothing unexplained changed.`
  });
}

function createUnreadableViolation({ rootDir, file, reason }) {
  return Object.freeze({
    file: relativePath(rootDir, file),
    line: 1,
    specifier: "",
    rule: "unreadable",
    reason
  });
}

function violationsForSpecifier({ file, line, specifier, rootDir, generateDir }) {
  const importerIsGenerate = isInside(generateDir, file);
  const llmViolations =
    !importerIsGenerate && isDeniedLlmPackage(specifier)
      ? [createLlmViolation({ file, line, specifier, rootDir })]
      : [];
  const dbClientViolations = isDeniedDbClient(specifier)
    ? [createDbClientViolation({ file, line, specifier, rootDir })]
    : [];

  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
    return [...llmViolations, ...dbClientViolations];
  }

  const resolvedPath = path.resolve(path.dirname(file), specifier);
  const generateViolations =
    !importerIsGenerate && isInside(generateDir, resolvedPath)
      ? [createGenerateViolation({ file, line, specifier, resolvedPath, rootDir, generateDir })]
      : [];

  return [...llmViolations, ...dbClientViolations, ...generateViolations];
}

async function inspectFile({ file, rootDir, generateDir }) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return [
      createUnreadableViolation({
        rootDir,
        file,
        reason: `${relativePath(rootDir, file)} could not be read.`
      })
    ];
  }

  return source.split(/\r?\n/).flatMap((lineText, lineIndex) =>
    specifiersFromLine(lineText).flatMap((specifier) =>
      violationsForSpecifier({
        file,
        line: lineIndex + 1,
        specifier,
        rootDir,
        generateDir
      })
    )
  );
}

function sortViolations(violations) {
  return violations.toSorted((left, right) => {
    const fileOrder = left.file.localeCompare(right.file);
    return fileOrder === 0 ? left.line - right.line : fileOrder;
  });
}

async function checkImportBoundaryDetailed(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const generateDir = path.join(resolvedRoot, "generate");
  const walkResult = await walkMjsFiles(resolvedRoot);
  const fileViolations = await Promise.all(
    walkResult.files.map((file) => inspectFile({ file, rootDir: resolvedRoot, generateDir }))
  );
  const unreadableDirectoryViolations = walkResult.unreadableDirectories.map((directory) =>
    createUnreadableViolation({
      rootDir: resolvedRoot,
      file: directory,
      reason: `${relativePath(resolvedRoot, directory)} could not be scanned.`
    })
  );
  const violations = sortViolations([
    ...unreadableDirectoryViolations,
    ...fileViolations.flat()
  ]);

  return Object.freeze({
    ok: violations.length === 0,
    violations,
    filesScanned: walkResult.files.length
  });
}

export async function checkImportBoundary(rootDir) {
  const result = await checkImportBoundaryDetailed(rootDir);
  return Object.freeze({
    ok: result.ok,
    violations: result.violations
  });
}

async function main() {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = path.dirname(path.dirname(thisFile));
  const rootArg = process.argv[2] ?? path.join(repoRoot, "src");
  const rootDir = path.resolve(process.cwd(), rootArg);
  const result = await checkImportBoundaryDetailed(rootDir);

  if (result.ok) {
    console.log(`import boundary: ${result.filesScanned} files scanned, 0 violations`);
    process.exit(0);
  }

  for (const violation of result.violations) {
    console.error(`${violation.file}:${violation.line}  ${violation.rule}  ${violation.reason}`);
  }

  process.exit(1);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
