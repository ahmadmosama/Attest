import { defineDbCapabilities } from "../../../capabilities/db-caps.mjs";
import { SNAPSHOT_BLIND_SPOTS } from "../../capture/snapshot-diff.mjs";

/**
 * What a snapshot diff can honestly claim.
 *
 * `deltaAssertion` is true: the four bucket classifier and the typed rule engine
 * run exactly as they do on Postgres, and an unexplained change still fails the
 * run. What is false is everything a diff cannot know. Declaring ordering or
 * attribution here would let a derived rule claim a source mutation this
 * strategy never observed, which is how a suppression rule quietly becomes a
 * blanket ignore.
 */
export const SQLITE_DEGRADED = Object.freeze([
  "sqlite capture is snapshot diff, not a change stream",
  ...SNAPSHOT_BLIND_SPOTS
]);

export function sqliteCapabilities({ journalMode = null } = {}) {
  return defineDbCapabilities({
    driver: "sqlite",
    capture: "snapshot",
    deltaAssertion: true,
    boundedPolling: true,
    ordering: false,
    txAttribution: false,
    // The fence is the snapshot pair itself, taken by the harness, not a marker
    // row written into the app's own tables.
    watermarkFencing: "external",
    beforeImages: "full",
    transactionalTeardown: false,
    degraded: [
      ...SQLITE_DEGRADED,
      ...(journalMode !== null && String(journalMode).toLowerCase() !== "wal"
        ? [
            `journal_mode is ${journalMode}, not wal, so a snapshot can block or be blocked by a concurrent writer`
          ]
        : [])
    ]
  });
}
