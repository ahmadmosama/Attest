# Web Surface

The web surface runs scenarios through Playwright against an HTTP or HTTPS app target. It is a real adapter, not the in process fake, and it is selected by the CLI when no `ATTEST_SURFACE_ADAPTER=fake` environment override is present.

## Chrome Channel

WEB-01 requires Google Chrome through Playwright's `chrome` channel. Bare Chromium is refused.

The rule is enforced twice:

1. `src/config/schema.mjs` defaults `web.channel` to `chrome` and rejects `chromium`.
2. `src/surfaces/web/adapter.mjs` and `src/surfaces/web/session.mjs` validate the channel before preflight and launch. `null`, an empty string, `chromium`, and non Chrome channels produce named usage errors.

The CLI banner prints `web: real (chrome)` for a real web run so an acceptance test can prove it did not accidentally use the fake adapter.

## Capabilities

The web descriptor in `src/surfaces/web/capabilities.mjs` declares these surface capabilities:

```text
file_upload
network_control
permission_control
clipboard_control
clock_control
raw_escape
```

It deliberately does not declare `app_lifecycle`. A scenario containing `background` or `foreground` demands that capability, so lowering reports the web scenario as skipped instead of treating the operation as a no op. The runtime can then decide whether a skip is allowed or converted to exit code 4 through `failOnSkip`.

## Locators

Bindings live in `bindings/<app>/web.yaml`. A scenario references only semantic refs such as `button:place_order` or `field:email`; selectors stay in the binding file.

The binding priority is:

1. `testId`: maps to `page.getByTestId(value)`. The test id attribute defaults to `data-testid`.
2. `accessibilityId`: maps to a web aria-label lookup, `locator("[aria-label=\"value\"]")`.
3. `role` plus optional `name`: maps to `getByRole(role)` or `getByRole(role, { name, exact: true })`.
4. Raw `css` or `xpath`: maps to Playwright `locator()`. Raw selectors are the escape hatch and should be used only when portable handles are unavailable.

`nth` and `within` are disambiguators. `nth` calls Playwright `nth(index)` after the primary locator is built. `within` scopes the lookup to a test id container only. The value may be `product-grid` or `testId:product-grid`; other scoped locator types are intentionally unsupported in Phase 2.

## Execution Model

`open` navigates to a screen path relative to the app base URL and then waits for the screen `ready` locator to converge. Actions such as `tap`, `fill`, and `upload_file` use Playwright actionability with explicit timeouts. Assertions use the shared convergence function in `src/runtime/converge.mjs`, polling until the expected state is observed or the step budget expires.

That split is intentional. Playwright is best at determining whether an action can be performed. Attest owns assertion polling so browser assertions and later database assertions share the same bounded convergence model and can report elapsed convergence time, attempts, expected value, observed value, and locator details in the run record.

## Timeout Budgets

Default browser scale budgets are defined in `src/config/schema.mjs`:

```text
stepMs: 30000
scenarioMs: 300000
preflightMs: 15000
openMs: 60000
evidenceMs: 60000
closeMs: 30000
```

`--timeout-step` and `--timeout-scenario` override the step and scenario budgets from the CLI. The adapter also derives Playwright action and assertion timeouts from the active step budget for the session.
