# Scenario Format

Attest keeps test intent, surface bindings, and runtime execution separate.

## Layers

| Layer | File | Owns |
| --- | --- | --- |
| Intent | `scenarios/*.attest.yaml` | Scenario id, requirement IDs, tags, semantic steps |
| Bindings | `bindings/<app>/<surface>.yaml` | SemanticRef to surface locator mappings |
| Runtime | CLI flags, config, artifacts | App target, selected surfaces, timeouts, run reports |

A scenario names SemanticRefs only. Selectors, URLs, platform names, fixed waits, and branch logic are outside Layer 1.

```yaml
id: checkout.guest_purchase
requirement: [REQ-CHK-004]
tags: [smoke, checkout]
steps:
  - open: screen:catalog
  - tap: item:first_product
  - expect_visible: screen:product_detail
```

## Closed Vocabulary

| Category | Ops |
| --- | --- |
| Navigation | `open`, `back`, `background`, `foreground` |
| Interaction | `tap`, `long_press`, `fill`, `clear`, `press_key`, `swipe`, `scroll_until_visible`, `select_option`, `upload_file` |
| Environment | `set_permission`, `set_network`, `set_clipboard` |
| Assertion | `expect_visible`, `expect_hidden`, `expect_text`, `expect_state`, `expect_count` |
| Structure | `checkpoint`, `run_flow`, `delta_window` |
| Escape hatch | `raw` |

There are 25 operations. Any other step key is rejected before execution.

## Banned Constructs

| Code | Construct | Reason |
| --- | --- | --- |
| `E_BANNED_SLEEP` | `sleep`, `pause`, `delay` | Convergence and timeouts belong to the runner |
| `E_BANNED_FIXED_WAIT` | `wait`, `wait_ms`, `timeout_ms`, duration keys | Fixed waits make scenarios timing dependent |
| `E_BANNED_CONDITIONAL` | `if`, `when`, `unless`, `platform`, `only_on`, `skip_on` | A scenario must compile uniformly before surface selection |
| `E_SELECTOR_IN_SCENARIO` | `css`, `xpath`, `selector`, `locator`, selector shaped values | Selectors belong in bindings |
| `E_URL_IN_SCENARIO` | `url`, `path`, `href`, `deeplink`, URL shaped values | App routes belong in bindings or runner config |
| `E_PLATFORM_NAME_IN_SCENARIO` | `web`, `android`, `ios`, browser and driver names | Surface names belong in bindings or CLI filters |
| `E_UNKNOWN_OP` | Any step outside the 25 ops | The vocabulary is closed |
| `E_WILDCARD_ENTITY` | Wildcards in ignore style suppressions | Suppressions must name concrete entities |
| `E_RAW_WITHOUT_REASON` | `raw` without a reason of at least 10 characters | Escape hatches must explain why semantics were insufficient |

## Raw Escape Hatch

`raw` is per surface and must include a written reason.

```yaml
steps:
  - raw:
      reason: captcha has no accessible handle
      web:
        script: document.querySelector("[data-test=captcha]").click()
      android:
        uiautomator: new UiSelector().description("captcha")
```

Raw use is counted in `run.json` under `escapeHatch.rawOpUses` and each use records scenario id, surface, step index, and reason.

## Capability Gating

| Outcome | Meaning |
| --- | --- |
| Plan | All demanded capabilities are available and the scenario lowers to an execution plan |
| Skip | A surface capability is missing and the run can report the scenario as skipped |
| Compile error | A database capability is demanded without a configured driver, such as `E_DELTA_UNSUPPORTED` |

## Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | Pass |
| 1 | Scenario failure |
| 2 | Harness error |
| 3 | Usage or compile error |
| 4 | Skipped scenario treated as failure |

## Artifacts

Each run writes a per run artifact directory under the configured artifact root.

```text
<artifactRoot>/<runId>/
  run.json
  junit.xml
  report.html
  manifest.json
  scenarios/
    <scenarioId>__<surface>/
      plan.json
      evidence/
        network.jsonl
        step-<index>-checkpoint-<label>.png
        failure.png
        video.webm
        trace.zip
        trace-error.json
```

`run.json` contains filters, scenario results, timeout telemetry, requirement coverage, escape hatch counts, and artifact references. `junit.xml` and `report.html` are generated from the same run record.

For web binding details see [web-surface.md](web-surface.md). For retention and redaction details see [evidence-bundle.md](evidence-bundle.md).
