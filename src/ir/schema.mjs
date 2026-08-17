import { z } from "zod";

import { OP_CATEGORIES, OPS } from "./ops.mjs";
import { isSemanticRef } from "./semantic-ref.mjs";
import { SuppressionSchema } from "./suppression.mjs";

const SCENARIO_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const REQUIREMENT_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]+$/;
const TAG_PATTERN = /^[a-z][a-z0-9_-]*$/;
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const LABEL_PATTERN = /^[a-z][a-z0-9_]*$/;

const SemanticRefSchema = z.string().refine(isSemanticRef, {
  message: "Expected SemanticRef kind:name"
});

const NonEmptyStringSchema = z.string().trim().min(1);
const ScenarioIdSchema = z.string().regex(SCENARIO_ID_PATTERN);
const EntityNameSchema = z.string().regex(NAME_PATTERN);
const JsonObjectSchema = z.record(z.string(), z.unknown());

const MutationSchema = z
  .object({
    entity: EntityNameSchema,
    op: z.enum(["insert", "update", "delete"]),
    count: z.number().int().positive(),
    where: JsonObjectSchema.optional(),
    changed: z.array(z.string().regex(NAME_PATTERN)).min(1).optional()
  })
  .strict();

const TargetOnlySchema = z.union([
  SemanticRefSchema,
  z
    .object({
      target: SemanticRefSchema
    })
    .strict()
]);

const FillSchema = z
  .object({
    target: SemanticRefSchema,
    value: NonEmptyStringSchema
  })
  .strict();

const ExpectTextSchema = z
  .object({
    target: SemanticRefSchema,
    equals: NonEmptyStringSchema
  })
  .strict();

const ExpectCountSchema = z
  .object({
    target: SemanticRefSchema,
    equals: z.number().int().nonnegative()
  })
  .strict();

const ExpectStateSchema = z
  .object({
    target: SemanticRefSchema,
    equals: NonEmptyStringSchema.optional(),
    state: NonEmptyStringSchema.optional()
  })
  .strict();

const PressKeySchema = z.union([
  NonEmptyStringSchema,
  z
    .object({
      key: NonEmptyStringSchema
    })
    .strict()
]);

const SwipeSchema = z
  .object({
    target: SemanticRefSchema.optional(),
    direction: z.enum(["up", "down", "left", "right"])
  })
  .strict();

const SelectOptionSchema = z
  .object({
    target: SemanticRefSchema,
    value: NonEmptyStringSchema
  })
  .strict();

const UploadFileSchema = z
  .object({
    target: SemanticRefSchema,
    path: NonEmptyStringSchema
  })
  .strict();

const SetPermissionSchema = z
  .object({
    name: NonEmptyStringSchema,
    value: z.boolean()
  })
  .strict();

const SetNetworkSchema = z.union([
  z.enum(["online", "offline"]),
  z
    .object({
      mode: z.enum(["online", "offline"])
    })
    .strict()
]);

const SetClipboardSchema = z.union([
  NonEmptyStringSchema,
  z
    .object({
      value: NonEmptyStringSchema
    })
    .strict()
]);

const RawSchema = z
  .object({
    reason: NonEmptyStringSchema,
    web: JsonObjectSchema.optional(),
    android: JsonObjectSchema.optional(),
    ios: JsonObjectSchema.optional()
  })
  .strict();

const DeltaOpenSchema = z
  .object({
    delta_window: z.literal("open")
  })
  .strict();

const DeltaCloseSchema = z
  .object({
    delta_window: z.literal("close"),
    expect_mutations: z.array(MutationSchema).min(1).optional(),
    require_no_unexplained: z.boolean().optional()
  })
  .strict();

const NoArgumentSchema = z.union([
  z.literal(true),
  z.null(),
  z
    .object({})
    .strict()
]);

const OP_VALUE_SCHEMAS = Object.freeze({
  open: TargetOnlySchema,
  back: NoArgumentSchema,
  background: NoArgumentSchema,
  foreground: NoArgumentSchema,
  tap: TargetOnlySchema,
  long_press: TargetOnlySchema,
  fill: FillSchema,
  clear: TargetOnlySchema,
  press_key: PressKeySchema,
  swipe: SwipeSchema,
  scroll_until_visible: TargetOnlySchema,
  select_option: SelectOptionSchema,
  upload_file: UploadFileSchema,
  set_permission: SetPermissionSchema,
  set_network: SetNetworkSchema,
  set_clipboard: SetClipboardSchema,
  expect_visible: TargetOnlySchema,
  expect_hidden: TargetOnlySchema,
  expect_text: ExpectTextSchema,
  expect_state: ExpectStateSchema,
  expect_count: ExpectCountSchema,
  checkpoint: z.string().regex(LABEL_PATTERN),
  run_flow: ScenarioIdSchema,
  raw: RawSchema
});

function unknownStepReason(input) {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const keys = Object.keys(input);
    const op = keys.find((key) => !OPS.includes(key)) ?? keys[0];
    if (typeof op === "string") {
      return `Unknown operation "${op}"`;
    }
  }

  return "Step must be a single operation object";
}

function buildStepSchemas() {
  const schemas = [];

  for (const opName of Object.values(OP_CATEGORIES).flat()) {
    if (opName === "delta_window") {
      schemas.push(DeltaOpenSchema, DeltaCloseSchema);
      continue;
    }

    schemas.push(
      z
        .object({
          [opName]: OP_VALUE_SCHEMAS[opName]
        })
        .strict()
    );
  }

  return schemas;
}

export const StepSchema = z.union(buildStepSchemas(), {
  error: (issue) => unknownStepReason(issue.input)
});

export const ScenarioSchema = z
  .object({
    id: ScenarioIdSchema,
    requirement: z.array(z.string().regex(REQUIREMENT_ID_PATTERN)).min(1),
    tags: z.array(z.string().regex(TAG_PATTERN)).optional(),
    capabilities: z.array(NonEmptyStringSchema).optional(),
    // A generated scenario carries this in the file itself, not only in its
    // path. A proposal copied somewhere else is still a proposal, and the
    // runner refuses it wherever it finds it. Promotion is what removes it.
    proposed: z.literal(true).optional(),
    data: z
      .object({
        seed: NonEmptyStringSchema
      })
      .strict()
      .optional(),
    suppressions: z.array(SuppressionSchema).optional(),
    steps: z.array(StepSchema).min(1)
  })
  .strict();

export function toJsonSchema() {
  return z.toJSONSchema(ScenarioSchema);
}
