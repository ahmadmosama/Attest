import { PLAN_OP_KINDS } from "../plan.mjs";

function targetRef(step) {
  return step.value.target;
}

function targetLocator(step, ctx) {
  return ctx.resolve(targetRef(step)).locator;
}

function keyValue(value) {
  return typeof value === "string" ? value : value.key;
}

function networkMode(value) {
  return typeof value === "string" ? value : value.mode;
}

function clipboardValue(value) {
  return typeof value === "string" ? value : value.value;
}

export function lowerInteraction(step, ctx) {
  switch (step.op) {
    case "tap":
      return [{ kind: PLAN_OP_KINDS.tap, locator: targetLocator(step, ctx) }];
    case "long_press":
      return [{ kind: PLAN_OP_KINDS.long_press, locator: targetLocator(step, ctx) }];
    case "fill":
      return [{ kind: PLAN_OP_KINDS.fill, locator: targetLocator(step, ctx), value: step.value.value }];
    case "clear":
      return [{ kind: PLAN_OP_KINDS.clear, locator: targetLocator(step, ctx) }];
    case "press_key":
      return [{ kind: PLAN_OP_KINDS.press_key, key: keyValue(step.value) }];
    case "swipe":
      return [
        {
          kind: PLAN_OP_KINDS.swipe,
          direction: step.value.direction,
          ...(step.value.target === undefined ? {} : { locator: targetLocator(step, ctx) })
        }
      ];
    case "scroll_until_visible":
      return [{ kind: PLAN_OP_KINDS.scroll_until_visible, locator: targetLocator(step, ctx) }];
    case "select_option":
      return [
        { kind: PLAN_OP_KINDS.select_option, locator: targetLocator(step, ctx), value: step.value.value }
      ];
    case "upload_file":
      return [
        { kind: PLAN_OP_KINDS.upload_file, locator: targetLocator(step, ctx), path: step.value.path }
      ];
    case "set_permission":
      return [{ kind: PLAN_OP_KINDS.set_permission, name: step.value.name, value: step.value.value }];
    case "set_network":
      return [{ kind: PLAN_OP_KINDS.set_network, mode: networkMode(step.value) }];
    case "set_clipboard":
      return [{ kind: PLAN_OP_KINDS.set_clipboard, value: clipboardValue(step.value) }];
    default:
      return ctx.unlowered(step);
  }
}
