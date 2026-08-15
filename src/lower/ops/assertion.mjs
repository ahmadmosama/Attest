import { PLAN_OP_KINDS } from "../plan.mjs";

function targetLocator(step, ctx) {
  return ctx.resolve(step.value.target).locator;
}

export function lowerAssertion(step, ctx) {
  switch (step.op) {
    case "expect_visible":
      return [{ kind: PLAN_OP_KINDS.expect_visible, locator: targetLocator(step, ctx) }];
    case "expect_hidden":
      return [{ kind: PLAN_OP_KINDS.expect_hidden, locator: targetLocator(step, ctx) }];
    case "expect_text":
      return [
        {
          kind: PLAN_OP_KINDS.expect_text,
          locator: targetLocator(step, ctx),
          equals: step.value.equals
        }
      ];
    case "expect_state":
      return [
        {
          kind: PLAN_OP_KINDS.expect_state,
          locator: targetLocator(step, ctx),
          ...(step.value.equals === undefined ? {} : { equals: step.value.equals }),
          ...(step.value.state === undefined ? {} : { state: step.value.state })
        }
      ];
    case "expect_count":
      return [
        {
          kind: PLAN_OP_KINDS.expect_count,
          locator: targetLocator(step, ctx),
          equals: step.value.equals
        }
      ];
    default:
      return ctx.unlowered(step);
  }
}
