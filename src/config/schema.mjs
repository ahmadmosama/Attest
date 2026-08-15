import { z } from "zod";

export const DEFAULTS = Object.freeze({
  artifactRoot: ".attest/runs",
  scenariosGlob: Object.freeze(["scenarios/**/*.attest.yaml"]),
  bindingsDir: "bindings",
  app: null,
  surfaces: Object.freeze(["web"]),
  timeouts: Object.freeze({
    stepMs: 30000,
    scenarioMs: 300000
  }),
  failOnSkip: true,
  concurrency: 1,
  color: false
});

const NonEmptyString = z.string().trim().min(1);
const StringList = z.array(NonEmptyString).min(1);
const TimeoutMs = z.number().int().positive();

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
        scenarioMs: TimeoutMs.default(DEFAULTS.timeouts.scenarioMs)
      })
      .strict()
      .default(DEFAULTS.timeouts),
    failOnSkip: z.boolean().default(DEFAULTS.failOnSkip),
    concurrency: z.number().int().positive().default(DEFAULTS.concurrency),
    color: z.boolean().default(DEFAULTS.color)
  })
  .strict();
