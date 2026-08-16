import { z } from "zod";

export const DEFAULTS = Object.freeze({
  artifactRoot: ".attest/runs",
  scenariosGlob: Object.freeze(["scenarios/**/*.attest.yaml"]),
  bindingsDir: "bindings",
  app: null,
  surfaces: Object.freeze(["web"]),
  // Browser-scale budgets: openMs covers a Chrome cold start on a loaded
  // Windows host, evidenceMs covers stopping trace and video capture, and
  // closeMs covers browser teardown plus moving files into the bundle. The
  // Phase 1 fake-sized 5000ms and 1000ms budgets would make healthy browser
  // runs look like infrastructure failures.
  timeouts: Object.freeze({
    stepMs: 30000,
    scenarioMs: 300000,
    preflightMs: 15000,
    openMs: 60000,
    evidenceMs: 60000,
    closeMs: 30000
  }),
  web: Object.freeze({
    channel: "chrome",
    testIdAttribute: "data-testid",
    viewport: Object.freeze({
      width: 1280,
      height: 720
    })
  }),
  failOnSkip: true,
  concurrency: 1,
  color: false
});

const NonEmptyString = z.string().trim().min(1);
const StringList = z.array(NonEmptyString).min(1);
const TimeoutMs = z.number().int().positive();
const ViewportSize = z.number().int().positive();

export const ConfigSchema = z
  .object({
    artifactRoot: NonEmptyString.default(DEFAULTS.artifactRoot),
    scenariosGlob: StringList.default(DEFAULTS.scenariosGlob),
    bindingsDir: NonEmptyString.default(DEFAULTS.bindingsDir),
    app: NonEmptyString.nullable().default(DEFAULTS.app),
    surfaces: StringList.default(DEFAULTS.surfaces),
    timeouts: z
      .object({
        stepMs: TimeoutMs.default(DEFAULTS.timeouts.stepMs),
        scenarioMs: TimeoutMs.default(DEFAULTS.timeouts.scenarioMs),
        preflightMs: TimeoutMs.default(DEFAULTS.timeouts.preflightMs),
        openMs: TimeoutMs.default(DEFAULTS.timeouts.openMs),
        evidenceMs: TimeoutMs.default(DEFAULTS.timeouts.evidenceMs),
        closeMs: TimeoutMs.default(DEFAULTS.timeouts.closeMs)
      })
      .strict()
      .default(DEFAULTS.timeouts),
    web: z
      .object({
        channel: NonEmptyString.default(DEFAULTS.web.channel).refine((channel) => channel !== "chromium", {
          message: "WEB-01 requires channel chrome, not bare chromium"
        }),
        testIdAttribute: NonEmptyString.default(DEFAULTS.web.testIdAttribute),
        viewport: z
          .object({
            width: ViewportSize.default(DEFAULTS.web.viewport.width),
            height: ViewportSize.default(DEFAULTS.web.viewport.height)
          })
          .strict()
          .default(DEFAULTS.web.viewport)
      })
      .strict()
      .default(DEFAULTS.web),
    failOnSkip: z.boolean().default(DEFAULTS.failOnSkip),
    concurrency: z.number().int().positive().default(DEFAULTS.concurrency),
    color: z.boolean().default(DEFAULTS.color)
  })
  .strict();
