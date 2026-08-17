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
  // Android defaults are all null on purpose. An adb backend that guessed an
  // AVD name, or defaulted a serial, would silently drive whichever device
  // happened to be attached, which is the mobile version of taking the first
  // of several matching nodes.
  android: Object.freeze({
    avd: null,
    serial: null,
    package: null,
    activity: null,
    install: true,
    record: true,
    bootTimeoutMs: 180000,
    recordSeconds: 180,
    extras: Object.freeze({})
  }),
  failOnSkip: true,
  concurrency: 1,
  color: false,
  db: null
});

const NonEmptyString = z.string().trim().min(1);
const StringList = z.array(NonEmptyString).min(1);
const TimeoutMs = z.number().int().positive();
const ViewportSize = z.number().int().positive();

const DbAllowlistEntrySchema = z
  .object({
    host: NonEmptyString,
    database: NonEmptyString,
    nonProd: z.literal(true),
    note: NonEmptyString
  })
  .strict();

const DbConfigSchema = z
  .object({
    allowlist: z.array(DbAllowlistEntrySchema),
    rulesFile: NonEmptyString.nullable().default(null),
    redaction: z
      .object({
        sensitive: z.array(NonEmptyString).default([]),
        mode: z.enum(["hash", "mask"]).default("hash")
      })
      .strict()
      .default({ sensitive: [], mode: "hash" }),
    convergeTimeoutMs: TimeoutMs.default(10000),
    quietPeriodMs: TimeoutMs.default(750),
    quietPeriodCapMs: TimeoutMs.default(5000),
    tenantPrefix: NonEmptyString.default("attest"),
    url: z.never({ error: "db.url is not allowed. Set ATTEST_DB_URL in the environment." }).optional()
  })
  .strict();

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
    android: z
      .object({
        avd: NonEmptyString.nullable().default(DEFAULTS.android.avd),
        serial: NonEmptyString.nullable().default(DEFAULTS.android.serial),
        package: NonEmptyString.nullable().default(DEFAULTS.android.package),
        activity: NonEmptyString.nullable().default(DEFAULTS.android.activity),
        install: z.boolean().default(DEFAULTS.android.install),
        record: z.boolean().default(DEFAULTS.android.record),
        bootTimeoutMs: TimeoutMs.default(DEFAULTS.android.bootTimeoutMs),
        // adb screenrecord refuses anything longer, so the config cannot ask
        // for something the device will reject at run time.
        recordSeconds: z.number().int().positive().max(180).default(DEFAULTS.android.recordSeconds),
        extras: z.record(z.string(), z.string()).default(DEFAULTS.android.extras)
      })
      .strict()
      .default(DEFAULTS.android),
    failOnSkip: z.boolean().default(DEFAULTS.failOnSkip),
    concurrency: z.number().int().positive().default(DEFAULTS.concurrency),
    color: z.boolean().default(DEFAULTS.color),
    db: DbConfigSchema.nullable().default(DEFAULTS.db)
  })
  .strict();
