import { AttestError } from "../../errors.mjs";

/**
 * Read requirements, and any declared intent, out of a spec document.
 *
 * Nothing here infers behaviour. A requirement without a declared scenario is
 * reported as ungrounded, never invented, which is GEN-05: generation asserts
 * declared intent rather than recording current behaviour.
 *
 * "Declared" is literal. A spec may carry an ```attest fenced block holding the
 * steps that requirement means, and that block is the only thing this parser
 * will turn into a scenario. Prose is read for the requirement ID and its
 * statement, and for nothing else.
 */

// Matches the requirement lines Ahmad's own specs use, in both shapes GSD emits:
//   - [ ] **DROID-01**: Runner starts, boot gates, and shuts down an AVD
//   | DROID-01 | Phase 5 | Done |
const REQUIREMENT_LINE_RE = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?\*\*([A-Z][A-Z0-9]*-\d+)\*\*\s*:\s*(.+?)\s*$/u;
const REQUIREMENT_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/u;
const FENCE_RE = /^\s*```(\w*)\s*$/u;
const REQUIREMENT_DIRECTIVE_RE = /^\s*#\s*requirement:\s*([A-Z][A-Z0-9]*-\d+(?:\s*,\s*[A-Z][A-Z0-9]*-\d+)*)\s*$/u;

function parseError(reason, details = {}) {
  return new AttestError("E_SPEC_PARSE_INVALID", "Could not read the spec document", { reason, ...details });
}

export function isRequirementId(value) {
  return typeof value === "string" && REQUIREMENT_ID_RE.test(value);
}

/**
 * Every requirement the document states, with the sentence that states it.
 */
export function parseRequirements(text, { file = "spec.md" } = {}) {
  if (typeof text !== "string") {
    throw parseError("text_not_string", { file });
  }

  const found = new Map();

  text.split(/\r?\n/u).forEach((line, index) => {
    const match = REQUIREMENT_LINE_RE.exec(line);
    if (match === null) {
      return;
    }

    const [, id, statement] = match;
    if (found.has(id)) {
      // A requirement stated twice in one document is a spec bug, and silently
      // keeping one of them would hide it.
      throw parseError("duplicate_requirement", { file, id, line: index + 1 });
    }

    found.set(id, Object.freeze({ id, statement, file, line: index + 1 }));
  });

  return Object.freeze([...found.values()]);
}

/**
 * Every ```attest block the document carries, with the requirements it declares
 * it covers.
 *
 * The block states its own requirements with a `# requirement: ID, ID` comment
 * on its first line. A block that names none cannot be linked, and an unlinked
 * scenario is exactly what GEN-01 forbids.
 */
export function parseScenarioBlocks(text, { file = "spec.md" } = {}) {
  if (typeof text !== "string") {
    throw parseError("text_not_string", { file });
  }

  const lines = text.split(/\r?\n/u);
  const blocks = [];
  let open = null;

  lines.forEach((line, index) => {
    const fence = FENCE_RE.exec(line);

    if (fence !== null && open === null && fence[1] === "attest") {
      open = { startLine: index + 1, body: [] };
      return;
    }

    if (fence !== null && open !== null) {
      const requirements = [];
      const body = [];

      for (const bodyLine of open.body) {
        const directive = REQUIREMENT_DIRECTIVE_RE.exec(bodyLine);
        if (directive === null) {
          body.push(bodyLine);
        } else {
          requirements.push(...directive[1].split(",").map((id) => id.trim()));
        }
      }

      blocks.push(
        Object.freeze({
          file,
          startLine: open.startLine,
          endLine: index + 1,
          requirements: Object.freeze(requirements),
          body: body.join("\n").trim()
        })
      );
      open = null;
      return;
    }

    if (open !== null) {
      open.body.push(line);
    }
  });

  if (open !== null) {
    throw parseError("unterminated_block", { file, line: open.startLine });
  }

  return Object.freeze(blocks);
}

/**
 * One document, read completely.
 */
export function parseSpec(text, { file = "spec.md" } = {}) {
  const requirements = parseRequirements(text, { file });
  const blocks = parseScenarioBlocks(text, { file });
  const stated = new Set(requirements.map((requirement) => requirement.id));

  return Object.freeze({
    file,
    requirements,
    blocks,
    // A block claiming a requirement this document never states is a link to
    // nothing. Reported rather than accepted, because the whole value of the
    // link is that it points somewhere real.
    danglingLinks: Object.freeze(
      blocks.flatMap((block) =>
        block.requirements.filter((id) => !stated.has(id)).map((id) => Object.freeze({ id, block: block.startLine }))
      )
    )
  });
}
