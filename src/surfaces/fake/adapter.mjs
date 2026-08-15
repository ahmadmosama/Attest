import { AttestError, InfraError, UnsupportedOpError } from "../../errors.mjs";
import { defineSurfaceCapabilities } from "../../capabilities/surface-caps.mjs";
import { assertKnownCapability } from "../../capabilities/registry.mjs";
import { capabilitiesFor, OP_CAPABILITIES } from "../../ir/ops.mjs";
import { assertImplementsSurfacePort } from "../port.mjs";
import { defineScript } from "./script.mjs";

function freezeReference(reference) {
  return Object.freeze({ ...reference });
}

function freezeTranscript(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

function opKind(planOp) {
  if (planOp === null || typeof planOp !== "object" || Array.isArray(planOp)) {
    throw new AttestError("E_BAD_PLAN_OP", "Plan op must be an object", {
      reason: "op_not_object"
    });
  }

  if (typeof planOp.kind !== "string" || planOp.kind.length === 0) {
    throw new AttestError("E_BAD_PLAN_OP", "Plan op kind must be a non empty string", {
      reason: "kind_not_string"
    });
  }

  return planOp.kind;
}

function opIndex(planOp, fallback) {
  if (planOp.i === undefined) {
    return fallback;
  }

  if (!Number.isSafeInteger(planOp.i) || planOp.i < 0) {
    throw new AttestError("E_BAD_PLAN_OP", "Plan op index must be a non negative integer", {
      reason: "invalid_index",
      i: planOp.i
    });
  }

  return planOp.i;
}

function explicitCapabilities(planOp) {
  if (planOp.capabilities === undefined) {
    return null;
  }

  if (!Array.isArray(planOp.capabilities)) {
    throw new AttestError("E_BAD_PLAN_OP", "Plan op capabilities must be an array", {
      reason: "capabilities_not_array"
    });
  }

  return Object.freeze(
    planOp.capabilities.map((capability) => {
      assertKnownCapability(capability);
      return capability;
    })
  );
}

function demandedCapabilities(planOp) {
  const explicit = explicitCapabilities(planOp);
  if (explicit !== null) {
    return explicit;
  }

  const kind = opKind(planOp);
  if (OP_CAPABILITIES[kind] === undefined) {
    return Object.freeze([]);
  }

  return capabilitiesFor(kind, planOp.value ?? planOp);
}

function messageFor(entry, fallback) {
  return entry.message ?? fallback;
}

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export function createFakeSurface(script) {
  const normalizedScript = defineScript(script);
  const descriptor = defineSurfaceCapabilities({
    surface: normalizedScript.surface,
    supports: normalizedScript.supports
  });
  const transcript = [];
  const closedSessions = new Set();
  let sessionSeq = 0;

  function append({ i, kind, outcome }) {
    transcript.push(
      Object.freeze({
        i,
        kind,
        at: `fake:${transcript.length}`,
        outcome
      })
    );
  }

  function scriptedEntry(kind, i) {
    return normalizedScript.byIndex[String(i)] ?? normalizedScript.byKind[kind] ?? null;
  }

  const adapter = {
    get transcript() {
      return freezeTranscript(transcript);
    },

    describeCapabilities() {
      return descriptor;
    },

    preflight() {
      return Object.freeze({ ok: true });
    },

    open() {
      const session = Object.freeze({
        id: `fake-session-${sessionSeq}`,
        surface: normalizedScript.surface
      });
      sessionSeq += 1;
      return session;
    },

    execute(session, planOp, { signal } = {}) {
      if (closedSessions.has(session)) {
        throw new AttestError("E_SESSION_CLOSED", "Fake surface session is closed", {
          sessionId: session?.id
        });
      }

      if (signal?.aborted) {
        throw abortReason(signal);
      }

      const kind = opKind(planOp);
      const i = opIndex(planOp, transcript.length);
      const missing = demandedCapabilities(planOp).filter((capability) => !descriptor.has(capability));

      if (missing.length > 0) {
        append({ i, kind, outcome: "unsupported" });
        throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Fake surface does not support plan op", {
          i,
          kind,
          missing
        });
      }

      const entry = scriptedEntry(kind, i);
      if (entry === null && normalizedScript.unknownKind === "throw") {
        append({ i, kind, outcome: "unscripted" });
        throw new AttestError("E_UNSCRIPTED_OP", "Fake surface has no script entry for plan op", {
          i,
          kind
        });
      }

      const outcome = entry?.outcome ?? "ok";
      append({ i, kind, outcome });

      if (outcome === "fail") {
        throw new AttestError("E_FAKE_OP_FAILED", messageFor(entry, "Fake surface op failed"), {
          i,
          kind
        });
      }

      if (outcome === "infra") {
        throw new InfraError("E_FAKE_INFRA", messageFor(entry, "Fake surface infrastructure failure"), {
          i,
          kind
        });
      }

      if (outcome === "hang") {
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
        });
      }

      return Object.freeze({ ok: true, detail: Object.freeze({ i, kind }) });
    },

    collectEvidence(session, kind, { bundle } = {}) {
      if (closedSessions.has(session)) {
        throw new AttestError("E_SESSION_CLOSED", "Fake surface session is closed", {
          sessionId: session?.id
        });
      }

      const text = `fake evidence\nsession=${session?.id ?? "none"}\nkind=${kind}\n`;
      if (bundle === null || bundle === undefined) {
        return freezeReference({ kind, path: null, bytes: Buffer.byteLength(text) });
      }

      if (typeof bundle.writeTextArtifact === "function") {
        const reference = bundle.writeTextArtifact(kind, text);
        return reference instanceof Promise ? reference.then(freezeReference) : freezeReference(reference);
      }

      if (typeof bundle.writeArtifact === "function") {
        const reference = bundle.writeArtifact(kind, text);
        return reference instanceof Promise ? reference.then(freezeReference) : freezeReference(reference);
      }

      throw new AttestError("E_BAD_BUNDLE", "Evidence bundle does not expose an artifact writer", {
        kind
      });
    },

    close(session) {
      if (session !== null && typeof session === "object") {
        closedSessions.add(session);
      }

      return Object.freeze({ ok: true });
    }
  };

  assertImplementsSurfacePort(adapter);
  return Object.freeze(adapter);
}
