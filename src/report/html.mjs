import { RunRecordSchema } from "./run-record.mjs";
import { escapeHtml, inlineArtifact } from "./inline.mjs";

const CSP = "default-src 'none'; img-src data: ; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const EMPTY = Object.freeze([]);

function coreRecordForSchema(record) {
  return {
    ...record,
    requirements: {
      covered: record?.requirements?.covered ?? [],
      byScenario: record?.requirements?.byScenario ?? {}
    }
  };
}

function parseRecord(record) {
  const parsed = RunRecordSchema.parse(coreRecordForSchema(record));
  return {
    ...parsed,
    requirements: {
      ...parsed.requirements,
      uncovered: record?.requirements?.uncovered ?? [],
      unknown: record?.requirements?.unknown ?? []
    }
  };
}

function className(...names) {
  return names.filter(Boolean).join(" ");
}

function formatMs(value) {
  return `${Number(value ?? 0).toLocaleString("en-US")} ms`;
}

function listText(values) {
  return values.length === 0 ? "None" : values.join(", ");
}

function jsonText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return JSON.stringify(value, null, 2);
}

function isProblemScenario(scenario) {
  return scenario.result !== "pass";
}

function isProblemStep(step) {
  return step.status === "fail" || step.status === "timed_out" || step.error !== null;
}

function sortedSteps(scenario) {
  return [...scenario.steps].toSorted((left, right) => left.index - right.index);
}

function bindingsHashLines(hashes) {
  const entries = Object.entries(hashes.bindings ?? {}).toSorted(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return ["none"];
  }

  return entries.map(([surface, hash]) => `${surface}: ${hash}`);
}

function metadataGrid(record) {
  const ruleset = record.hashes.ruleset ?? "none";
  return `
    <dl class="meta-grid">
      <div><dt>Run ID</dt><dd>${escapeHtml(record.runId)}</dd></div>
      <div><dt>Status</dt><dd><span class="pill result-${escapeHtml(record.status)}">${escapeHtml(record.status)}</span></dd></div>
      <div><dt>Exit code</dt><dd>${escapeHtml(record.exitCode)}</dd></div>
      <div><dt>Duration</dt><dd>${escapeHtml(formatMs(record.durationMs))}</dd></div>
      <div><dt>Started</dt><dd>${escapeHtml(record.startedAt)}</dd></div>
      <div><dt>Finished</dt><dd>${escapeHtml(record.finishedAt)}</dd></div>
      <div><dt>Node</dt><dd>${escapeHtml(`${record.node.version} on ${record.node.platform}`)}</dd></div>
      <div><dt>Attest</dt><dd>${escapeHtml(record.attestVersion)}</dd></div>
      <div><dt>Artifact dir</dt><dd>${escapeHtml(record.artifactDir)}</dd></div>
      <div><dt>Ruleset hash</dt><dd>${escapeHtml(ruleset)}</dd></div>
      <div class="wide"><dt>Bindings hashes</dt><dd>${bindingsHashLines(record.hashes)
        .map((line) => `<code>${escapeHtml(line)}</code>`)
        .join("")}</dd></div>
    </dl>`;
}

function countsLine(counts) {
  const parts = [
    `Total ${counts.total}`,
    `Passed ${counts.passed}`,
    `Failed ${counts.failed}`,
    `Infra error ${counts.infra_error}`,
    `Skipped ${counts.skipped}`,
    `Quarantined ${counts.quarantined}`
  ];
  return `<p class="counts-line">${parts.map((part) => `<span>${escapeHtml(part)}</span>`).join("")}</p>`;
}

function requirementsBlock(record) {
  const uncovered = record.requirements.uncovered ?? EMPTY;
  const unknown = record.requirements.unknown ?? EMPTY;
  return `
    <section class="run-section">
      <h2>Requirements</h2>
      <dl class="meta-grid compact">
        <div><dt>Covered</dt><dd>${escapeHtml(listText(record.requirements.covered))}</dd></div>
        <div><dt>Uncovered</dt><dd>${escapeHtml(listText(uncovered))}</dd></div>
        <div><dt>Unknown</dt><dd>${escapeHtml(listText(unknown))}</dd></div>
      </dl>
    </section>`;
}

function errorBlock(error, label = "Error") {
  if (error === null) {
    return "";
  }

  const details = jsonText(error.details);
  return `
    <div class="error-block">
      <h4>${escapeHtml(label)}</h4>
      <p><strong>${escapeHtml(error.code)}</strong> ${escapeHtml(error.message)}</p>
      ${details.length === 0 ? "" : `<pre>${escapeHtml(details)}</pre>`}
    </div>`;
}

function artifactPreview({ artifactDir, ref, scenario, step }) {
  const inlined = inlineArtifact({ artifactDir, ref });
  const title = `${scenario.id} step ${step.index} ${ref.kind}`;

  if (inlined.mode === "inline") {
    return `
      <figure class="artifact-preview">
        <img src="${escapeHtml(inlined.src)}" alt="${escapeHtml(title)}">
        <figcaption>${escapeHtml(ref.kind)} (${escapeHtml(ref.path)})</figcaption>
      </figure>`;
  }

  if (inlined.mode === "link") {
    return `
      <p class="artifact-link">
        <a href="${escapeHtml(inlined.href)}">${escapeHtml(ref.kind)} artifact</a>
        <span>${escapeHtml(ref.path)}</span>
      </p>`;
  }

  return `
    <p class="artifact-missing">
      Missing artifact: ${escapeHtml(ref.kind)} ${escapeHtml(ref.path)}
    </p>`;
}

function evidenceRow({ artifactDir, scenario, step }) {
  if (step.evidence.length === 0) {
    return "";
  }

  const previews = step.evidence.map((ref) => artifactPreview({ artifactDir, ref, scenario, step }));
  return `
    <tr class="evidence-row">
      <td colspan="5">${previews.join("")}</td>
    </tr>`;
}

function stepErrorCell(step) {
  if (step.error === null) {
    return "";
  }

  return `
    <div><strong>${escapeHtml(step.error.code)}</strong></div>
    <div>${escapeHtml(step.error.message)}</div>
    <pre>${escapeHtml(jsonText(step.error.details))}</pre>`;
}

function stepRows({ artifactDir, scenario }) {
  const rows = [];
  for (const step of sortedSteps(scenario)) {
    rows.push(`
      <tr class="${className("step-row", isProblemStep(step) && "step-problem")}">
        <td>${escapeHtml(step.index)}</td>
        <td>${escapeHtml(step.kind)}</td>
        <td><span class="pill step-${escapeHtml(step.status)}">${escapeHtml(step.status)}</span></td>
        <td>${escapeHtml(formatMs(step.durationMs))}</td>
        <td>${stepErrorCell(step)}</td>
      </tr>`);
    rows.push(evidenceRow({ artifactDir, scenario, step }));
  }

  return rows.join("");
}

function scenarioSummary(scenario) {
  return `
    <summary>
      <span class="scenario-id">${escapeHtml(scenario.id)}</span>
      <span>${escapeHtml(scenario.surface)}</span>
      <span class="pill result-${escapeHtml(scenario.result)}">${escapeHtml(scenario.result)}</span>
      <span>${escapeHtml(formatMs(scenario.durationMs))}</span>
    </summary>`;
}

function scenarioFacts(scenario) {
  const skipped = scenario.skipped === null ? "" : listText(scenario.skipped.capabilities);
  return `
    <dl class="scenario-facts">
      <div><dt>Requirements</dt><dd>${escapeHtml(listText(scenario.requirements))}</dd></div>
      <div><dt>Plan hash</dt><dd><code>${escapeHtml(scenario.planHash)}</code></dd></div>
      <div><dt>Plan path</dt><dd>${escapeHtml(scenario.planPath)}</dd></div>
      <div><dt>Raw op uses</dt><dd>${escapeHtml(scenario.rawOpUses)}</dd></div>
      ${skipped.length === 0 ? "" : `<div><dt>Skipped capabilities</dt><dd>${escapeHtml(skipped)}</dd></div>`}
    </dl>`;
}

function databaseDeltaExtension() {
  return `
    <section class="database-delta" data-extension-point="classified-database-delta">
      <h4>Database delta</h4>
    </section>`;
}

function scenarioBlock({ artifactDir, scenario }) {
  const open = isProblemScenario(scenario) ? " open" : "";
  const rows = stepRows({ artifactDir, scenario });
  return `
    <details class="scenario scenario-${escapeHtml(scenario.result)}"${open}>
      ${scenarioSummary(scenario)}
      <div class="scenario-body">
        ${scenarioFacts(scenario)}
        ${errorBlock(scenario.error, "Scenario error")}
        ${databaseDeltaExtension()}
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0 ? `<tr><td colspan="5" class="empty">No steps recorded</td></tr>` : rows}
          </tbody>
        </table>
      </div>
    </details>`;
}

function scenariosSection(record, artifactDir) {
  const blocks = record.scenarios.map((scenario) => scenarioBlock({ artifactDir, scenario }));
  const content = blocks.length === 0 ? `<p class="empty">No scenarios recorded</p>` : blocks.join("");
  return `
    <section class="run-section">
      <h2>Scenarios</h2>
      ${content}
    </section>`;
}

function styles() {
  return `
    :root { color-scheme: light; --bg: #f6f7f9; --panel: #ffffff; --ink: #17202a; --muted: #5f6b7a; --line: #d8dee8; --pass: #16794c; --fail: #b42318; --infra: #7a2e9b; --skip: #8a5a00; --quarantine: #5f6b7a; --focus: #fff3cd; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { background: #243447; color: #fff; padding: 24px; border-bottom: 4px solid #16a085; }
    header h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; letter-spacing: 0; }
    header p { margin: 0; }
    h2 { margin: 0 0 14px; font-size: 20px; letter-spacing: 0; }
    h4 { margin: 0 0 8px; font-size: 14px; letter-spacing: 0; }
    code, pre { font-family: "Cascadia Mono", Consolas, monospace; }
    pre { margin: 8px 0 0; padding: 10px; overflow: auto; background: #f1f4f8; border: 1px solid var(--line); border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
    a { color: #0b5cab; }
    .counts-line { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .counts-line span, .pill { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 8px; border-radius: 6px; font-weight: 700; background: #e9eef5; color: var(--ink); }
    .run-section { margin-top: 20px; }
    .meta-grid, .scenario-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 16px 0 0; }
    .meta-grid div, .scenario-facts div { min-width: 0; padding: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    .meta-grid.compact div { background: #fbfcfe; }
    .wide { grid-column: 1 / -1; }
    dt { color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    dd { margin: 2px 0 0; overflow-wrap: anywhere; }
    dd code { display: block; margin-top: 2px; overflow-wrap: anywhere; }
    .scenario { margin-top: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .scenario[open] { border-color: #9fb3c8; }
    summary { display: grid; grid-template-columns: minmax(220px, 1fr) 120px 120px 110px; gap: 10px; align-items: center; padding: 12px 14px; cursor: pointer; }
    .scenario-id { font-weight: 800; overflow-wrap: anywhere; }
    .scenario-body { border-top: 1px solid var(--line); padding: 14px; }
    .result-pass, .step-pass { color: #fff; background: var(--pass); }
    .result-fail, .step-fail, .step-timed_out { color: #fff; background: var(--fail); }
    .result-infra_error { color: #fff; background: var(--infra); }
    .result-skipped, .step-skipped { color: #fff; background: var(--skip); }
    .result-quarantined { color: #fff; background: var(--quarantine); }
    .error-block { margin: 12px 0; padding: 12px; border: 1px solid #f1b8b3; border-left: 5px solid var(--fail); background: #fff8f7; border-radius: 8px; }
    .database-delta { margin: 12px 0; padding: 10px 0 0; border-top: 1px solid var(--line); }
    table { width: 100%; margin-top: 12px; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 9px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; background: #f9fafc; }
    th:nth-child(1), td:nth-child(1) { width: 70px; }
    th:nth-child(3), td:nth-child(3) { width: 120px; }
    th:nth-child(4), td:nth-child(4) { width: 110px; }
    .step-problem { background: var(--focus); outline: 2px solid #d39e00; outline-offset: -2px; }
    .artifact-preview { margin: 8px 0; }
    .artifact-preview img { display: block; max-width: min(100%, 900px); height: auto; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
    figcaption, .artifact-link span, .artifact-missing, .empty { color: var(--muted); }
    .artifact-link { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
    @media (max-width: 720px) { main { padding: 12px; } header { padding: 18px; } summary { grid-template-columns: 1fr; } table { table-layout: auto; } th:nth-child(1), td:nth-child(1), th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4) { width: auto; } }
  `;
}

export function renderHtmlReport(runRecord, { artifactDir } = {}) {
  const record = parseRecord(runRecord);
  const resolvedArtifactDir = artifactDir ?? record.artifactDir;
  const scenarios = scenariosSection(record, resolvedArtifactDir);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(CSP)}">
  <title>Attest report ${escapeHtml(record.runId)}</title>
  <style>${styles()}</style>
</head>
<body>
  <header>
    <h1>Attest run report</h1>
    <p>${escapeHtml(record.status)} with exit code ${escapeHtml(record.exitCode)}</p>
    ${countsLine(record.counts)}
  </header>
  <main>
    ${metadataGrid(record)}
    ${requirementsBlock(record)}
    ${scenarios}
  </main>
</body>
</html>
`;
}
