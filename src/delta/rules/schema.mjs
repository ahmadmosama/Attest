import { z } from "zod";

import {
  DerivedSchema,
  ExternalWriterSchema,
  IgnoreSchema,
  VolatileColumnsSchema
} from "../../ir/suppression.mjs";

export const RULESET_VERSION = 1;

const DEFAULT_RULE_CAP = 50;
const RULE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const RuleIdSchema = z.string().regex(RULE_ID_PATTERN);

const RuleMetadataSchema = z
  .object({
    id: RuleIdSchema,
    cap: z.number().int().positive().default(DEFAULT_RULE_CAP),
    note: z.string().trim().min(1).optional()
  })
  .strict();

function withRuleMetadata(schema) {
  return schema.merge(RuleMetadataSchema).strict();
}

function supportedVersionMessage() {
  return `ruleset version must be ${RULESET_VERSION}`;
}

function uniqueRuleIds(value, context) {
  const seen = new Map();

  for (const [index, rule] of value.rules.entries()) {
    const previous = seen.get(rule.id);
    if (previous !== undefined) {
      context.addIssue({
        code: "custom",
        message: `duplicate rule id "${rule.id}"`,
        path: ["rules", index, "id"]
      });
      context.addIssue({
        code: "custom",
        message: `duplicate rule id "${rule.id}"`,
        path: ["rules", previous, "id"]
      });
      continue;
    }

    seen.set(rule.id, index);
  }
}

export const RuleSchema = z.discriminatedUnion("kind", [
  withRuleMetadata(VolatileColumnsSchema),
  withRuleMetadata(DerivedSchema),
  withRuleMetadata(ExternalWriterSchema),
  withRuleMetadata(IgnoreSchema)
]);

export const RulesetSchema = z
  .object({
    version: z.literal(RULESET_VERSION, {
      error: supportedVersionMessage
    }),
    rules: z.array(RuleSchema).default([])
  })
  .strict()
  .superRefine(uniqueRuleIds);
