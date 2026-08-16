import { z } from "zod";

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const WILDCARD_ENTITY_CHAR_PATTERN = /[*%]/;

const ENTITY_WILDCARD_MESSAGE =
  "DELTA-08 wildcard table names are banned for ignore rules";

const NonEmptyStringSchema = z.string().trim().min(1);
const EntityNameSchema = z.string().regex(NAME_PATTERN);

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function hasIgnoreWildcard(entity) {
  return WILDCARD_ENTITY_CHAR_PATTERN.test(entity) || entity.endsWith("_");
}

function hasNonEmptyIdentityValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function futureOrTodayDate(value) {
  return value >= todayIsoDate();
}

export const SUPPRESSION_KINDS = Object.freeze([
  "volatile_columns",
  "derived",
  "external_writer",
  "ignore"
]);

const SuppressionBaseSchema = z
  .object({
    entity: EntityNameSchema
  })
  .strict();

const CausedBySchema = z
  .object({
    entity: EntityNameSchema,
    op: z.enum(["insert", "update", "delete"])
  })
  .strict();

const TransactionIdentitySchema = z
  .object({
    by: z.literal("transaction"),
    not_in: z.literal("scenario_transactions")
  })
  .strict();

const ApplicationNameIdentitySchema = z
  .object({
    by: z.literal("application_name"),
    not_equals: NonEmptyStringSchema.refine(hasNonEmptyIdentityValue, {
      message: "external_writer identity not_equals must name a writer"
    })
  })
  .strict();

const ExternalWriterIdentitySchema = z.discriminatedUnion("by", [
  TransactionIdentitySchema,
  ApplicationNameIdentitySchema
]);

const IgnoreEntitySchema = z
  .string()
  .refine((entity) => !hasIgnoreWildcard(entity), {
    message: ENTITY_WILDCARD_MESSAGE
  })
  .pipe(EntityNameSchema);

export const VolatileColumnsSchema = SuppressionBaseSchema.extend({
  kind: z.literal("volatile_columns"),
  paths: z.array(NonEmptyStringSchema).min(1)
}).strict();

export const DerivedSchema = SuppressionBaseSchema.extend({
  kind: z.literal("derived"),
  caused_by: CausedBySchema,
  mechanism: NonEmptyStringSchema,
  per_source: z.number().int().positive()
}).strict();

export const ExternalWriterSchema = SuppressionBaseSchema.extend({
  kind: z.literal("external_writer"),
  identity: ExternalWriterIdentitySchema
}).strict();

export const IgnoreSchema = z
  .object({
    kind: z.literal("ignore"),
    entity: IgnoreEntitySchema,
    reason: NonEmptyStringSchema,
    expires: z.iso.date().refine(futureOrTodayDate, {
      message: "ignore rule expires must not be expired"
    })
  })
  .strict();

export const SuppressionSchema = z.discriminatedUnion("kind", [
  VolatileColumnsSchema,
  DerivedSchema,
  ExternalWriterSchema,
  IgnoreSchema
]);
