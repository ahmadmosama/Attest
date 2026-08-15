import { createDiagnostic, DiagnosticList } from "../ir/diagnostics.mjs";
import { parseSemanticRef } from "../ir/semantic-ref.mjs";
import { resolveRef } from "./resolve.mjs";

function refKey(ref) {
  const parsed = typeof ref === "string" ? parseSemanticRef(ref) : parseSemanticRef(`${ref.kind}:${ref.name}`);
  return `${parsed.kind}:${parsed.name}`;
}

function sortUnique(values) {
  return Object.freeze([...new Set(values)].toSorted());
}

function bindingFile(bindings, surface) {
  return bindings?.file ?? `${surface}.yaml`;
}

function bindingRefs(bindings) {
  return sortUnique([
    ...Object.keys(bindings?.elements ?? {}),
    ...Object.keys(bindings?.screens ?? {}),
    ...Object.keys(bindings?.states ?? {})
  ]);
}

function hasBinding(bindings, ref) {
  const parsed = parseSemanticRef(ref);
  if (parsed.kind === "screen") {
    return bindings?.screens?.[ref] !== undefined;
  }
  if (parsed.kind === "state") {
    return bindings?.states?.[ref] !== undefined;
  }
  return bindings?.elements?.[ref] !== undefined;
}

function addDiagnostic(diagnostics, input) {
  diagnostics.add(createDiagnostic(input));
}

function rawElementRefs(bindings) {
  const refs = [];
  for (const ref of Object.keys(bindings?.elements ?? {}).toSorted()) {
    const resolved = resolveRef(bindings, ref);
    if (resolved.usedRaw) {
      refs.push(ref);
    }
  }
  return Object.freeze(refs);
}

function coverageForSurface({ refs, surface, bindings, diagnostics }) {
  const unbound = [];
  const file = bindingFile(bindings, surface);

  for (const ref of refs) {
    if (hasBinding(bindings, ref)) {
      continue;
    }

    unbound.push(ref);
    addDiagnostic(diagnostics, {
      file,
      line: 1,
      col: 1,
      code: "E_UNBOUND_REF",
      reason: `SemanticRef ${ref} has no binding on surface ${surface} in ${file}`,
      path: ["bindings", surface, ref]
    });
  }

  const usedSet = new Set(refs);
  for (const ref of bindingRefs(bindings)) {
    if (usedSet.has(ref)) {
      continue;
    }

    addDiagnostic(diagnostics, {
      file,
      line: 1,
      col: 1,
      code: "E_BINDING_UNUSED",
      reason: `Binding ${ref} on surface ${surface} is not used by any scenario`,
      severity: "warning",
      path: ["bindings", surface, ref]
    });
  }

  const rawRefs = rawElementRefs(bindings);
  if (rawRefs.length > 0) {
    addDiagnostic(diagnostics, {
      file,
      line: 1,
      col: 1,
      code: "E_RAW_SELECTOR",
      reason: `Surface ${surface} uses ${rawRefs.length} raw element selector binding(s): ${rawRefs.join(", ")}`,
      severity: "warning",
      path: ["bindings", surface]
    });
  }

  return Object.freeze({
    bound: refs.length - unbound.length,
    unbound: Object.freeze(unbound),
    rawCount: rawRefs.length
  });
}

export function lintBindings({ refsUsed, bindingsBySurface, surfaces }) {
  if (!Array.isArray(refsUsed)) {
    throw new TypeError("lintBindings refsUsed must be an array");
  }
  if (bindingsBySurface === null || typeof bindingsBySurface !== "object") {
    throw new TypeError("lintBindings bindingsBySurface must be an object");
  }
  if (!Array.isArray(surfaces)) {
    throw new TypeError("lintBindings surfaces must be an array");
  }

  const refs = sortUnique(refsUsed.map((ref) => refKey(ref)));
  const sortedSurfaces = sortUnique(surfaces);
  const diagnostics = new DiagnosticList();
  const coverage = {};

  for (const surface of sortedSurfaces) {
    coverage[surface] = coverageForSurface({
      refs,
      surface,
      bindings: bindingsBySurface[surface],
      diagnostics
    });
  }

  return Object.freeze({
    ok: diagnostics.ok,
    diagnostics,
    coverage: Object.freeze(coverage)
  });
}
