import { DiagnosticList } from "./diagnostics.mjs";
import { parseScenarioFile as parseFile, parseScenarioText as parseText } from "./parse.mjs";
import { validateScenario } from "./validate.mjs";

const MAX_SCENARIO_BYTES = 1024 * 1024;

function mergeDiagnostics(...lists) {
  const diagnostics = new DiagnosticList();
  for (const list of lists) {
    for (const diagnostic of list.all) {
      diagnostics.add(diagnostic);
    }
  }
  return diagnostics;
}

function compileParsed(parsed) {
  if (parsed.ast === null) {
    return { ir: null, diagnostics: parsed.diagnostics };
  }

  const validated = validateScenario(parsed.ast);
  const diagnostics = mergeDiagnostics(validated.diagnostics, parsed.diagnostics);

  return {
    ir: diagnostics.ok ? validated.ir : null,
    diagnostics
  };
}

export async function compileScenarioFile(path) {
  return compileParsed(await parseFile(path));
}

export function compileScenarioText(text, { file }) {
  if (Buffer.byteLength(text, "utf8") > MAX_SCENARIO_BYTES) {
    const diagnostics = new DiagnosticList();
    diagnostics.add({
      file,
      line: 1,
      col: 1,
      code: "E_SCENARIO_TOO_LARGE",
      reason: "Scenario file exceeds 1 MiB"
    });
    return { ir: null, diagnostics };
  }

  return compileParsed(parseText(text, { file }));
}
