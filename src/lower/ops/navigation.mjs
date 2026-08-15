import { PLAN_OP_KINDS } from "../plan.mjs";

function targetRef(step) {
  return step.value.target;
}

function lowerOpen(step, ctx) {
  const resolved = ctx.resolve(targetRef(step));
  const locator = resolved.locator;

  if (locator.strategy !== "screen") {
    return [{ kind: PLAN_OP_KINDS.open, target: locator }];
  }

  const { ready, strategy: _strategy, ...target } = locator;
  return [{ kind: PLAN_OP_KINDS.open, target, ready }];
}

export function lowerNavigation(step, ctx) {
  switch (step.op) {
    case "open":
      return lowerOpen(step, ctx);
    case "back":
      return [{ kind: PLAN_OP_KINDS.back }];
    case "background":
      return [{ kind: PLAN_OP_KINDS.background }];
    case "foreground":
      return [{ kind: PLAN_OP_KINDS.foreground }];
    default:
      return ctx.unlowered(step);
  }
}
