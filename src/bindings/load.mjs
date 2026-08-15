import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import stringify from "json-stable-stringify";
import { parseDocument } from "yaml";

import { AttestError } from "../errors.mjs";
import { BindingsSchema } from "./schema.mjs";

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function hashPayload(bindings) {
  return {
    surface: bindings.surface,
    elements: bindings.elements ?? {},
    screens: bindings.screens ?? {},
    states: bindings.states ?? {}
  };
}

function issueCode(issue) {
  const [code] = issue.message.split(":");
  return code.startsWith("E_") ? code : "E_BINDINGS_INVALID";
}

function issueReason(issue) {
  const [, ...rest] = issue.message.split(":");
  return rest.length > 0 ? rest.join(":").trim() : issue.message;
}

function bindingSchemaError(error, file) {
  const issues = error.issues.map((issue) =>
    Object.freeze({
      code: issueCode(issue),
      reason: issueReason(issue),
      path: Object.freeze([...issue.path])
    })
  );
  const first = issues[0] ?? { code: "E_BINDINGS_INVALID", reason: "Bindings file is invalid" };
  const code = issues.some((issue) => issue.code === "E_COORDINATE_BINDING")
    ? "E_COORDINATE_BINDING"
    : first.code;

  return new AttestError(code, `Invalid bindings file ${file}: ${first.reason}`, {
    file,
    issues: Object.freeze(issues)
  });
}

function parseBindingsYaml(text, file) {
  const doc = parseDocument(text, {
    uniqueKeys: true,
    merge: false
  });

  if (doc.errors.length > 0) {
    throw new AttestError("E_BINDINGS_YAML", `Invalid bindings YAML ${file}`, {
      file,
      reason: doc.errors[0].message.split("\n")[0]
    });
  }

  try {
    return doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new AttestError("E_BINDINGS_YAML", `Invalid bindings YAML ${file}`, {
      file,
      reason: error.message
    });
  }
}

export function hashBindings(bindings) {
  const canonical = stringify(hashPayload(bindings));
  return createHash("sha256").update(canonical).digest("hex");
}

export async function loadBindings({ dir, app, surface }) {
  if (typeof dir !== "string" || dir.trim().length === 0) {
    throw new TypeError("loadBindings dir must be a non empty string");
  }
  if (typeof app !== "string" || app.trim().length === 0) {
    throw new TypeError("loadBindings app must be a non empty string");
  }
  if (typeof surface !== "string" || surface.trim().length === 0) {
    throw new TypeError("loadBindings surface must be a non empty string");
  }

  const file = path.join(dir, app, `${surface}.yaml`);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AttestError("E_BINDINGS_NOT_FOUND", `Bindings file not found: ${file}`, {
        file,
        app,
        surface
      });
    }
    throw new AttestError("E_BINDINGS_READ_FAILED", `Failed to read bindings file: ${file}`, {
      file,
      app,
      surface,
      reason: error.message
    });
  }

  const value = parseBindingsYaml(text, file);
  const parsed = BindingsSchema.safeParse(value);
  if (!parsed.success) {
    throw bindingSchemaError(parsed.error, file);
  }

  if (parsed.data.surface !== surface) {
    throw new AttestError(
      "E_BINDINGS_SURFACE_MISMATCH",
      `Bindings file ${file} declares surface ${parsed.data.surface}, expected ${surface}`,
      { file, app, surface, declaredSurface: parsed.data.surface }
    );
  }

  const body = deepFreeze(parsed.data);
  const bindings = {
    app,
    surface: body.surface,
    elements: body.elements,
    screens: body.screens,
    states: body.states,
    hash: hashBindings(body),
    file
  };

  return deepFreeze(bindings);
}
