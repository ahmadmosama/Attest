import { AttestError } from "../errors.mjs";

export const SURFACE_CAPABILITIES = Object.freeze([
  "file_upload",
  "network_control",
  "app_lifecycle",
  "permission_control",
  "clipboard_control",
  "clock_control",
  "raw_escape"
]);

export const DB_CAPABILITIES = Object.freeze(["db.delta_assertion", "db.bounded_polling"]);

export const ALL_CAPABILITIES = Object.freeze([...SURFACE_CAPABILITIES, ...DB_CAPABILITIES]);

const ALL_CAPABILITY_SET = new Set(ALL_CAPABILITIES);

export function isDbCapability(name) {
  return typeof name === "string" && name.startsWith("db.");
}

export function assertKnownCapability(name) {
  if (typeof name !== "string" || !ALL_CAPABILITY_SET.has(name)) {
    throw new AttestError("E_UNKNOWN_CAPABILITY", "Unknown capability", { capability: name });
  }

  return name;
}
