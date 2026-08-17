import { InfraError } from "../../../errors.mjs";

/**
 * MySQL preflight.
 *
 * Two refusals and one degradation, all read from the server rather than
 * assumed. The refusals exist because the alternative is a run that captures
 * nothing and therefore reports no unexplained changes, which reads as a pass.
 */

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function binlogDisabled() {
  return new InfraError("E_MYSQL_BINLOG_DISABLED", "The binary log is off on this server", {
    remediation:
      "Start mysqld with --log-bin. Without a binary log there is nothing to capture, and a run would report no unexplained changes because it saw none at all."
  });
}

function formatRefusal(format) {
  return new InfraError("E_MYSQL_BINLOG_FORMAT", `This server writes a ${format} binary log, not ROW`, {
    binlogFormat: format,
    remediation:
      "SET GLOBAL binlog_format=ROW, and reconnect. STATEMENT and MIXED carry SQL text rather than per row before and after images, so no row level change can be recovered from them."
  });
}

function privilegeRefusal(grants) {
  return new InfraError("E_MYSQL_REPLICATION_PRIVILEGE", "This user cannot read the binary log", {
    grantsSeen: grants.length,
    remediation:
      "GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* to this user. Attest reads the binlog as a replica does."
  });
}

function hasReplicationGrant(grants) {
  return grants.some((grant) => {
    const text = lower(grant);
    return text.includes("replication slave") || text.includes("all privileges");
  });
}

/**
 * `binlog_row_image` decides how much of each row the log carries.
 *
 * FULL is every column before and after. MINIMAL is the key plus what changed,
 * so an update's before image is partial and a delete carries only the key.
 * That is a degradation, not a refusal: the classifier can still work, it just
 * has less to compare, and it must be told rather than left to assume.
 */
export function beforeImagesFor(rowImage) {
  return lower(rowImage) === "full" ? "full" : "key_only";
}

export async function runMysqlPreflight({ variables, grants, signal } = {}) {
  if (signal?.aborted === true) {
    throw new InfraError("E_DB_PREFLIGHT_ABORTED", "MySQL driver preflight was aborted.", {
      reason: String(signal.reason ?? "aborted")
    });
  }

  if (typeof variables !== "function") {
    throw new InfraError("E_MYSQL_CLIENT_MISSING", "No MySQL client is wired in", {
      remediation:
        "Install and inject the MySQL client. The driver keeps it behind an injected seam so the format refusals stay testable without a server."
    });
  }

  const read = await variables({ signal });
  const logBin = lower(read?.log_bin);
  const format = lower(read?.binlog_format);
  const rowImage = lower(read?.binlog_row_image);

  if (logBin === "off" || logBin === "0" || logBin === "") {
    throw binlogDisabled();
  }

  if (format !== "row") {
    throw formatRefusal(format.toUpperCase() || "UNKNOWN");
  }

  const grantList = typeof grants === "function" ? (await grants({ signal })) ?? [] : [];
  if (typeof grants === "function" && !hasReplicationGrant(grantList)) {
    throw privilegeRefusal(grantList);
  }

  return Object.freeze({
    ok: true,
    binlogFormat: "ROW",
    rowImage: rowImage || "full",
    beforeImages: beforeImagesFor(rowImage || "full"),
    degraded:
      beforeImagesFor(rowImage || "full") === "full"
        ? Object.freeze([])
        : Object.freeze([
            `binlog_row_image is ${rowImage.toUpperCase()}, not FULL, so an update carries a partial before image and a delete carries only its key`,
            "SET GLOBAL binlog_row_image=FULL for complete before images"
          ])
  });
}
