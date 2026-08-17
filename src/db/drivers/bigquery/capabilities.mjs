import { defineDbCapabilities } from "../../../capabilities/db-caps.mjs";

/**
 * BigQuery declares less than every other driver, on purpose.
 *
 * Adjudicated conflict C3: BigQuery cannot honestly answer "nothing unexplained
 * changed". It is an append oriented sink written by unrelated pipelines, the
 * streaming buffer delays queryability, and DML against buffered rows is
 * restricted. A driver that claimed otherwise would produce a green gate that
 * verified nothing, which is worse than having no gate.
 *
 * `deltaAssertion: false` is the whole mechanism. The Phase 1 lowerer already
 * refuses a scenario demanding a capability the driver does not declare, so the
 * refusal is a property of the capability system rather than a runtime check
 * somebody has to remember to write.
 */
export const BIGQUERY_DEGRADED = Object.freeze([
  "bigquery has no change capture: expected rows are polled, nothing else is observed",
  "no unexplained change detection: an unrelated pipeline writing to the same table is invisible",
  "no ordering and no attribution",
  "the streaming buffer delays queryability, so a just written row can be absent for minutes"
]);

export function bigQueryCapabilities() {
  return defineDbCapabilities({
    driver: "bigquery",
    capture: "none",
    // The one thing that must never flip to true without the reasoning in C3
    // being revisited first.
    deltaAssertion: false,
    boundedPolling: true,
    ordering: false,
    txAttribution: false,
    watermarkFencing: "none",
    beforeImages: "none",
    transactionalTeardown: false,
    degraded: BIGQUERY_DEGRADED
  });
}
