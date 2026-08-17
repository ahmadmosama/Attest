import { InfraError } from "../../../errors.mjs";

/**
 * Mongo preflight: the topology check, and why it is a refusal.
 *
 * Correction C4 in REQUIREMENTS.md: the brief claimed Mongo lacks cross
 * collection transactions. That is wrong. Mongo has them, and change streams,
 * but only on a replica set or a sharded cluster, never on a standalone mongod.
 *
 * So the real requirement is detecting a standalone deployment and refusing it
 * by name. Degrading quietly to polling would give a green run whose delta
 * assertions were never actually watched.
 */

export const TOPOLOGIES = Object.freeze(["standalone", "replicaSet", "sharded", "unknown"]);

function standaloneRefusal(details) {
  return new InfraError("E_MONGO_STANDALONE", "This MongoDB deployment is a standalone mongod", {
    ...details,
    remediation:
      "Change streams need an oplog, which a standalone does not have. Start mongod with --replSet and run rs.initiate(), or point the run at Atlas. Attest refuses rather than degrading to polling, because a delta assertion that was never watched is worse than no assertion."
  });
}

function privilegeRefusal(details) {
  return new InfraError("E_MONGO_CHANGE_STREAM_PRIVILEGE", "This user cannot open a change stream", {
    ...details,
    remediation:
      "Grant the changeStream and find privileges on the watched collections, for example the readAnyDatabase role on a test deployment."
  });
}

/**
 * Read the topology from a `hello` response.
 *
 * `setName` present means a replica set member. `msg: "isdbgrid"` means mongos,
 * so a sharded cluster. Neither present, and it is a standalone.
 */
export function topologyFrom(hello) {
  if (hello === null || typeof hello !== "object") {
    return "unknown";
  }

  if (hello.msg === "isdbgrid") {
    return "sharded";
  }

  if (typeof hello.setName === "string" && hello.setName.length > 0) {
    return "replicaSet";
  }

  if (hello.isWritablePrimary === true || hello.ismaster === true || hello.ok === 1) {
    return "standalone";
  }

  return "unknown";
}

export async function runMongoPreflight({ hello, canChangeStream = null, signal } = {}) {
  if (signal?.aborted === true) {
    throw new InfraError("E_DB_PREFLIGHT_ABORTED", "MongoDB driver preflight was aborted.", {
      reason: String(signal.reason ?? "aborted")
    });
  }

  if (typeof hello !== "function") {
    throw new InfraError("E_MONGO_CLIENT_MISSING", "No MongoDB client is wired in", {
      remediation:
        "Install and inject the MongoDB client. The driver keeps it behind an injected seam so the topology refusal stays testable without a server."
    });
  }

  const response = await hello({ signal });
  const topology = topologyFrom(response);

  if (topology === "standalone") {
    throw standaloneRefusal({ topology, setName: null });
  }

  if (topology === "unknown") {
    throw new InfraError("E_MONGO_TOPOLOGY_UNKNOWN", "Could not determine the MongoDB topology", {
      topology,
      remediation: "Check the connection string reaches a running deployment and that the user may run hello."
    });
  }

  if (typeof canChangeStream === "function") {
    const allowed = await canChangeStream({ signal });
    if (allowed !== true) {
      throw privilegeRefusal({ topology });
    }
  }

  return Object.freeze({
    ok: true,
    topology,
    setName: typeof response?.setName === "string" ? response.setName : null,
    // Pre images are a per collection setting, off by default. Without them an
    // update carries no before values, which the parser reports as value_only
    // fidelity rather than pretending otherwise.
    preImagesEnabled: response?.preImagesEnabled === true
  });
}
