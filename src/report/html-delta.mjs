import { escapeHtml } from "./inline.mjs";

function formatMsList(values) {
  if (values.length === 0) {
    return "none";
  }

  return values.map((value) => `${value} ms`).join(", ");
}

function scenarioKey(scenario) {
  return `${scenario.id}\0${scenario.surface}`;
}

function healthFlagList(health) {
  return [
    ...health.dead.map((rule) => `dead ${rule.ruleId} ${rule.proposedAction ?? "delete_rule"}`),
    ...health.expired.map((rule) => `expired ${rule.ruleId} ${rule.expires ?? "unknown"}`),
    ...health.expiringSoon.map((rule) => `expiring ${rule.ruleId} ${rule.expires ?? "unknown"}`)
  ];
}

function countPills(counts) {
  return `
    <p class="delta-counts">
      <span>expected ${escapeHtml(counts.expected)}</span>
      <span>explained ${escapeHtml(counts.explained)}</span>
      <span>suppressed external ${escapeHtml(counts.suppressed_external)}</span>
      <span>unexplained ${escapeHtml(counts.unexplained)}</span>
    </p>`;
}

function ruleRows(rules) {
  if (rules.length === 0) {
    return `<tr><td colspan="7" class="empty">No delta rules configured</td></tr>`;
  }

  return rules
    .map(
      (rule) => `
        <tr>
          <td>${escapeHtml(rule.id)}</td>
          <td>${escapeHtml(rule.kind)}</td>
          <td>${escapeHtml(rule.entity)}</td>
          <td>${escapeHtml(rule.suppressed)}</td>
          <td>${escapeHtml(rule.overBudget)}</td>
          <td>${escapeHtml(rule.cap === null ? "none" : rule.cap)}</td>
          <td>${escapeHtml(rule.flag)}</td>
        </tr>`
    )
    .join("");
}

function healthRows(view) {
  const flags = healthFlagList(view.health);
  if (flags.length === 0) {
    return `<p class="empty">No delta rule health flags</p>`;
  }

  return `<ul class="delta-health">${flags.map((flag) => `<li>${escapeHtml(flag)}</li>`).join("")}</ul>`;
}

export function renderDeltaSummary(view) {
  if (!view.present) {
    return "";
  }

  return `
    <section class="run-section delta-summary">
      <h2>Database Delta</h2>
      ${countPills(view.counts)}
      <dl class="meta-grid compact">
        <div><dt>Ruleset hash</dt><dd><code>${escapeHtml(view.rulesetHash)}</code></dd></div>
        <div><dt>Rule health</dt><dd>${healthRows(view)}</dd></div>
      </dl>
      <table class="delta-rule-table">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Kind</th>
            <th>Entity</th>
            <th>Suppressed</th>
            <th>Over budget</th>
            <th>Cap</th>
            <th>Health</th>
          </tr>
        </thead>
        <tbody>${ruleRows(view.rules)}</tbody>
      </table>
    </section>`;
}

function groupRows(group) {
  if (group.rows.length === 0) {
    return `<p class="empty">No sample rows recorded</p>`;
  }

  return `
    <table class="delta-row-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Columns</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        ${group.rows
          .map(
            (row) => `
              <tr>
                <td><code>${escapeHtml(row.key)}</code></td>
                <td>${escapeHtml(row.columnText)}</td>
                <td>${escapeHtml(row.notes.length === 0 ? "none" : row.notes.join("; "))}</td>
              </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

function unexplainedGroups(delta) {
  if (delta.unexplained.length === 0) {
    return "";
  }

  return `
    <div class="delta-groups">
      <h5>Unexplained changes</h5>
      ${delta.unexplained
        .map(
          (group) => `
            <section class="delta-group">
              <h6>${escapeHtml(group.entity)} ${escapeHtml(group.op)}: ${escapeHtml(group.count)} change(s)</h6>
              ${groupRows(group)}
              ${
                group.omitted === 0
                  ? ""
                  : `<p class="empty">${escapeHtml(group.omitted)} more ${escapeHtml(group.entity)} ${escapeHtml(group.op)} change(s) omitted</p>`
              }
            </section>`
        )
        .join("")}
    </div>`;
}

function shortfallRows(shortfalls) {
  if (shortfalls.length === 0) {
    return "";
  }

  return `
    <div class="delta-shortfalls">
      <h5>Missing expected mutations</h5>
      <table>
        <thead>
          <tr>
            <th>Entity</th>
            <th>Op</th>
            <th>Expected</th>
            <th>Observed</th>
            <th>Missing</th>
            <th>Columns</th>
          </tr>
        </thead>
        <tbody>
          ${shortfalls
            .map(
              (shortfall) => `
                <tr>
                  <td>${escapeHtml(shortfall.entity)}</td>
                  <td>${escapeHtml(shortfall.op)}</td>
                  <td>${escapeHtml(shortfall.expected)}</td>
                  <td>${escapeHtml(shortfall.observed)}</td>
                  <td>${escapeHtml(shortfall.missing)}</td>
                  <td>${escapeHtml(shortfall.columns.length === 0 ? "any" : shortfall.columns.join(", "))}</td>
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function capRows(capViolations) {
  if (capViolations.length === 0) {
    return "";
  }

  return `
    <div class="delta-cap-violations">
      <h5>Rule cap violations</h5>
      <ul>
        ${capViolations
          .map(
            (violation) =>
              `<li>${escapeHtml(violation.code)} ${escapeHtml(violation.ruleId)} count ${escapeHtml(violation.count)} cap ${escapeHtml(violation.cap ?? "none")} ${escapeHtml(violation.reason)}</li>`
          )
          .join("")}
      </ul>
    </div>`;
}

function findScenarioDelta(view, scenario) {
  const key = scenarioKey(scenario);
  return view.scenarios.find((delta) => scenarioKey({ id: delta.scenarioId, surface: delta.surface }) === key);
}

export function renderScenarioDelta(view, scenario) {
  if (!view.present) {
    return "";
  }

  const delta = findScenarioDelta(view, scenario);
  if (delta === undefined) {
    return "";
  }

  return `
    <section class="database-delta" data-extension-point="classified-database-delta">
      <h4>Database delta</h4>
      ${countPills(delta.counts)}
      <p class="delta-meta">Converge ${escapeHtml(formatMsList(delta.convergeMs))}; quiet ${escapeHtml(delta.quiet?.quiet === true ? "yes" : "no")}</p>
      ${unexplainedGroups(delta)}
      ${shortfallRows(delta.shortfalls)}
      ${capRows(delta.capViolations)}
    </section>`;
}
