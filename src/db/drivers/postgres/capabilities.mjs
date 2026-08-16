import { defineDbCapabilities } from "../../../capabilities/db-caps.mjs";

const FULL_CAPTURE = Object.freeze({
  capture: "logical_slot",
  deltaAssertion: true,
  boundedPolling: true,
  ordering: true,
  txAttribution: true,
  watermarkFencing: "inline",
  transactionalTeardown: true
});

const NO_CAPTURE = Object.freeze({
  capture: "none",
  deltaAssertion: false,
  boundedPolling: true,
  ordering: false,
  txAttribution: false,
  watermarkFencing: "none",
  transactionalTeardown: false
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function degradedMessages(findings) {
  return asArray(findings?.degraded).map((entry) =>
    typeof entry === "string" ? entry : entry.message
  );
}

function replicaIdentityFindings(findings) {
  return asArray(findings?.replicaIdentity).filter((entry) => entry.beforeImages !== "full");
}

function hasWalLevelLogical(findings) {
  return findings?.walLevel === "logical";
}

function hasReplicationPrivilege(findings) {
  return findings?.replicationPrivilege?.allowed === true;
}

function captureAvailable(findings) {
  return hasWalLevelLogical(findings) && hasReplicationPrivilege(findings);
}

function beforeImageMode(findings) {
  if (!captureAvailable(findings)) {
    return "none";
  }

  return replicaIdentityFindings(findings).length === 0 ? "full" : "key_only";
}

function uniqueMessages(messages) {
  const seen = new Set();
  const unique = [];

  for (const message of messages) {
    if (typeof message === "string" && message.length > 0 && !seen.has(message)) {
      seen.add(message);
      unique.push(message);
    }
  }

  return unique;
}

function capabilityFlags(findings) {
  return captureAvailable(findings) ? FULL_CAPTURE : NO_CAPTURE;
}

export function describePostgresCapabilities(findings = {}) {
  const flags = capabilityFlags(findings);

  return defineDbCapabilities({
    driver: "postgres",
    ...flags,
    beforeImages: beforeImageMode(findings),
    degraded: uniqueMessages(degradedMessages(findings))
  });
}
