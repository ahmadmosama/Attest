import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { AttestError } from "../errors.mjs";
import { hashRule } from "../delta/rules/hash.mjs";

const MUTANT_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const FIXTURE_SEGMENTS = Object.freeze(["fixtures", "self-verify"]);
const MUTANT_KINDS = Object.freeze([
  "omit_write",
  "wrong_value",
  "wrong_target",
  "extra_write",
  "skip_cascade"
]);

const MutantIdSchema = z.string().regex(MUTANT_ID_PATTERN);

export const MutantSchema = z
  .object({
    id: MutantIdSchema,
    kind: z.enum(MUTANT_KINDS),
    file: z.string().trim().min(1),
    find: z.string().min(1),
    replace: z.string(),
    seeds: z.string().trim().min(1),
    caught_by: z.string().trim().min(1),
    note: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.find === value.replace) {
      context.addIssue({
        code: "custom",
        message: "find and replace must differ",
        path: ["replace"]
      });
    }
  });

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function requireRoot(root) {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new TypeError("mutant root must be a non empty string");
  }

  return path.resolve(root);
}

function parseMutant(mutant) {
  return deepFreeze(MutantSchema.parse(mutant));
}

function rawSegments(file) {
  return file.split(/[\\/]+/u).filter((segment) => segment.length > 0);
}

function hasUnsafeSegment(segments) {
  return segments.some((segment) => segment === "." || segment === "..");
}

function startsWithFixtureScope(segments) {
  return (
    segments.length > FIXTURE_SEGMENTS.length &&
    segments[0] === FIXTURE_SEGMENTS[0] &&
    segments[1] === FIXTURE_SEGMENTS[1]
  );
}

function assertDeclaredFixturePath(mutant) {
  const segments = rawSegments(mutant.file);
  if (
    path.isAbsolute(mutant.file) ||
    hasUnsafeSegment(segments) ||
    !startsWithFixtureScope(segments)
  ) {
    throw new AttestError(
      "E_MUTANT_OUT_OF_SCOPE",
      "Mutant file must be inside fixtures/self-verify",
      {
        mutantId: mutant.id,
        file: mutant.file
      }
    );
  }
}

function assertResolvedFixturePath({ mutant, root }) {
  const target = path.resolve(root, mutant.file);
  const fixtureRoot = path.resolve(root, ...FIXTURE_SEGMENTS);
  const relative = path.relative(fixtureRoot, target);

  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
    throw new AttestError(
      "E_MUTANT_OUT_OF_SCOPE",
      "Mutant file must be inside fixtures/self-verify",
      {
        mutantId: mutant.id,
        file: mutant.file
      }
    );
  }

  return target;
}

function targetPathFor(mutant, root) {
  assertDeclaredFixturePath(mutant);
  return assertResolvedFixturePath({ mutant, root });
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashFile(file) {
  return sha256Buffer(await readFile(file));
}

function occurrenceCount(text, needle) {
  let count = 0;
  let offset = 0;

  while (offset <= text.length) {
    const index = text.indexOf(needle, offset);
    if (index === -1) {
      return count;
    }

    count += 1;
    offset = index + needle.length;
  }

  return count;
}

/**
 * Match and write in LF space, always.
 *
 * The corpus stores multi line fragments written with `\n`. A checkout that
 * produced CRLF made every one of them match zero times, so applying a mutant
 * failed with E_MUTANT_NOT_APPLICABLE and the corpus reported the fixture dirty:
 * a true statement about the wrong thing.
 *
 * `.gitattributes` pins LF and is the root fix. Normalising here is the second
 * lock.
 *
 * Matching happens in LF space; the file is written back in ITS OWN convention.
 * Normalising on write instead looked simpler and was wrong: it repaired the
 * whole file as a side effect of mutating one line, so the fixture tree hash
 * moved and revert failed with E_SELFVERIFY_FIXTURE_RESTORE_FAILED. A mutation
 * has to change exactly what it says it changes.
 */
function normalizeEndings(text) {
  return String(text).replaceAll("\r\n", "\n");
}

function restoreEndings(text, hadCrlf) {
  return hadCrlf ? text.replaceAll("\n", "\r\n") : text;
}

function replacementFor({ text: rawText, needle: rawNeedle, next: rawNext, mutant, file, absentCode, absentMessage }) {
  const hadCrlf = rawText.includes("\r\n");
  const text = normalizeEndings(rawText);
  const needle = normalizeEndings(rawNeedle);
  const next = normalizeEndings(rawNext);
  const count = occurrenceCount(text, needle);
  if (count === 0) {
    throw new AttestError(absentCode, absentMessage, {
      mutantId: mutant.id,
      file
    });
  }

  if (count > 1) {
    throw new AttestError("E_MUTANT_AMBIGUOUS", "Mutant source string is ambiguous", {
      mutantId: mutant.id,
      file,
      occurrences: count
    });
  }

  return restoreEndings(text.replace(needle, next), hadCrlf);
}

function mutationResult({ mutant, file, beforeHash, afterHash }) {
  return Object.freeze({
    mutantId: mutant.id,
    file: mutant.file,
    path: file,
    beforeHash,
    afterHash
  });
}

export function hashMutant(mutant) {
  return hashRule(parseMutant(mutant));
}

export async function applyMutant(mutant, { root = process.cwd() } = {}) {
  const parsed = parseMutant(mutant);
  const resolvedRoot = requireRoot(root);
  const file = targetPathFor(parsed, resolvedRoot);
  const beforeHash = await hashFile(file);
  const text = await readFile(file, "utf8");
  const next = replacementFor({
    text,
    needle: parsed.find,
    next: parsed.replace,
    mutant: parsed,
    file,
    absentCode: "E_MUTANT_NOT_APPLICABLE",
    absentMessage: "Mutant source string was not found"
  });

  await writeFile(file, next, "utf8");

  return mutationResult({
    mutant: parsed,
    file,
    beforeHash,
    afterHash: await hashFile(file)
  });
}

export async function revertMutant(mutant, { root = process.cwd() } = {}) {
  const parsed = parseMutant(mutant);
  const resolvedRoot = requireRoot(root);
  const file = targetPathFor(parsed, resolvedRoot);
  const beforeHash = await hashFile(file);
  const text = await readFile(file, "utf8");
  const next = replacementFor({
    text,
    needle: parsed.replace,
    next: parsed.find,
    mutant: parsed,
    file,
    absentCode: "E_MUTANT_NOT_APPLIED",
    absentMessage: "Mutant replacement string was not found"
  });

  await writeFile(file, next, "utf8");

  return mutationResult({
    mutant: parsed,
    file,
    beforeHash,
    afterHash: await hashFile(file)
  });
}
