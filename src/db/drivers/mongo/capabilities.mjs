import { defineDbCapabilities } from "../../../capabilities/db-caps.mjs";

/**
 * What a change stream can honestly claim.
 *
 * This is the strongest of the non Postgres drivers, and for the same reason
 * Postgres is strong: the source is an event log, not a counter or a diff. It
 * carries ordering, it carries the transaction an event belongs to, and for an
 * update it names the fields that changed.
 *
 * The one thing it does not carry by default is before images. Those are a per
 * collection setting that is off unless somebody turned it on, so the
 * descriptor reports what is actually configured rather than what is possible.
 */
export function mongoCapabilities({ preImagesEnabled = false } = {}) {
  return defineDbCapabilities({
    driver: "mongo",
    capture: "change_stream",
    deltaAssertion: true,
    boundedPolling: true,
    ordering: true,
    txAttribution: true,
    // The fence is a marker document written into a harness owned collection,
    // which the stream sees in order, exactly as the Postgres watermark rows
    // appear in the replication stream.
    watermarkFencing: "inline",
    beforeImages: preImagesEnabled ? "full" : "key_only",
    transactionalTeardown: false,
    degraded: preImagesEnabled
      ? []
      : [
          "pre images are off, so an update reports which fields changed and their new values but not the old ones",
          "enable changeStreamPreAndPostImages on the watched collections for full before images"
        ]
  });
}
