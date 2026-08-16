import { AttestError } from "../../errors.mjs";

function freezeStrategy(input) {
  return Object.freeze({ ...input });
}

export const CAPTURE_STRATEGIES = Object.freeze({
  logical_slot: freezeStrategy({
    name: "logical_slot",
    implemented: true,
    driverFamily: "postgres",
    parser: "test_decoding",
    ordering: "lsn",
    txAttribution: "xid"
  }),
  binlog: freezeStrategy({
    name: "binlog",
    implemented: false,
    driverFamily: "mysql",
    plannedPhase: "06"
  }),
  change_stream: freezeStrategy({
    name: "change_stream",
    implemented: false,
    driverFamily: "document",
    plannedPhase: "06"
  }),
  snapshot: freezeStrategy({
    name: "snapshot",
    implemented: false,
    driverFamily: "generic",
    plannedPhase: "06"
  })
});

function unsupported(details) {
  return new AttestError("E_DB_CAPTURE_UNSUPPORTED", "Database capture strategy is not supported", details);
}

function assertCaps(dbCaps) {
  if (dbCaps === null || typeof dbCaps !== "object" || Array.isArray(dbCaps)) {
    throw unsupported({
      driver: "unknown",
      capture: "unknown",
      reason: "capabilities_not_object"
    });
  }

  if (typeof dbCaps.driver !== "string" || dbCaps.driver.length === 0) {
    throw unsupported({
      driver: "unknown",
      capture: String(dbCaps.capture ?? "unknown"),
      reason: "missing_driver"
    });
  }

  if (typeof dbCaps.capture !== "string" || dbCaps.capture.length === 0) {
    throw unsupported({
      driver: dbCaps.driver,
      capture: "unknown",
      reason: "missing_capture"
    });
  }
}

export function selectCaptureStrategy(dbCaps) {
  assertCaps(dbCaps);

  const strategy = CAPTURE_STRATEGIES[dbCaps.capture];
  if (strategy?.implemented) {
    return strategy;
  }

  if (strategy) {
    throw unsupported({
      driver: dbCaps.driver,
      capture: dbCaps.capture,
      reason: "strategy_not_implemented",
      plannedPhase: strategy.plannedPhase
    });
  }

  throw unsupported({
    driver: dbCaps.driver,
    capture: dbCaps.capture,
    reason: dbCaps.capture === "none" ? "capture_none" : "unknown_capture"
  });
}
