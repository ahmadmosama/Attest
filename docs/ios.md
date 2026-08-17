# iOS Surface

iOS runs on a GitHub Actions macOS runner and nowhere else. That is not a deferral, it is a
relocation: the simulator cannot run on Windows or Linux, so the adapter is built here and
executed there.

## What that costs, and what it does not

The cost is that the one surface Ahmad cannot check locally is the one surface a broken change
would sit in unnoticed. Two things answer that:

1. **The job is blocking from day one.** There is no `continue-on-error` in
   `.github/workflows/ios.yml`, and a test asserts that. A surface that silently skips is how a
   gate becomes a lie.
2. **The adapter is fully exercised on Windows.** Every seam that touches the simulator is
   injected, so command construction, locator translation, ambiguity refusal, tap arithmetic,
   assertion convergence and evidence writing all execute in the ordinary gate against a scripted
   simctl. iOS is the fourth name in the conformance suite alongside fake, android and web.

That is IOS-02, and it exists because an adapter exercised only on CI rots between runs, and the
rot is invisible until the one time it matters.

## What is proven where

| | On Windows, every run | On the macOS runner |
|---|---|---|
| the surface port contract | yes, conformance suite | yes |
| locator translation and ambiguity refusal | yes | yes |
| simctl argv construction | yes, committed transcripts | yes |
| the .app versus .ipa refusal | yes | yes |
| a real simulator booting | no | yes |
| a real accessibility tree | no | yes |
| real taps and typing | no | yes |

The last three are the honest gap. On this host `preflight` refuses with `E_IOS_NO_SIMULATOR`
naming the macOS runner, rather than pretending a simulator might appear.

## The .app versus .ipa contract

Attest takes a **simulator `.app` bundle**, a directory or that directory zipped. It never takes
a device `.ipa`, because a simulator cannot install one. Passing an `.ipa` is refused with the
whole explanation rather than a confusing failure later:

```text
E_IOS_DEVICE_ARTIFACT  'build/Runner.ipa' is a device build. The iOS Simulator cannot install a
device .ipa. Build for `generic/platform=iOS Simulator` and pass the resulting .app bundle
(a directory, or that directory zipped) instead.
```

## Pinning, and why both

The workflow pins Xcode with `xcode-select` and pins the runtime version, then **asserts the
runtime exists** before the suite starts:

```yaml
env:
  XCODE_VERSION: "26.1"
  IOS_RUNTIME_VERSION: "26.1"
```

Trusting the image default is how a green job stops meaning anything: runner image issue 13853
had Xcode shipping ahead of its matching simulator runtime, so the default was unusable. The
assertion runs first so a missing runtime fails with a sentence naming what is missing, rather
than with a simctl error thirty steps later.

The simulator is shut down in an `if: always()` step, so a failed run does not leave one booted
for the next job on a reused runner.

## Capabilities

`src/surfaces/ios/capabilities.mjs` declares two:

```text
app_lifecycle
raw_escape
```

`simctl` can do more than that. `simctl privacy` grants permissions and `simctl pbcopy` sets the
clipboard, and neither is declared, because a capability is declared once the adapter drives it,
not once the tool could. On this surface that discipline matters more than anywhere else: an
overclaimed capability here would be a lie nobody could catch locally.

`clock_control` is a deliberate no even though `simctl status_bar` exists: it overrides the
displayed clock, not the clock the app reads, so declaring it would not mean what the capability
says.

## Locators

Bindings live in `bindings/<app>/ios.yaml`.

| Strategy | iOS meaning |
|---|---|
| `testId` and `accessibilityId` | both map to `accessibilityIdentifier` |
| `role` plus `name` | an explicit XCUIElement type allowlist, plus the name matched against label or title |
| `nth` | the declared way to choose among several matches |
| `within` | a container whose frame must contain the candidate's frame |
| raw `css`, `xpath`, `uiautomator`, `predicate` | refused with `E_RAW_SELECTOR_KIND` |

Both portable strategies land on `accessibilityIdentifier` rather than `accessibilityLabel`,
deliberately: the identifier is set for automation and is not shown to a user, while the label is
read aloud and is translated. Matching a label would make a scenario fail the moment the app
ships a second language.

**Visible means it has a frame, and deliberately does not mean enabled.** A disabled button is on
the screen, and `expect_state: disabled` has to be able to find it. Conflating the two made that
assertion unwritable, and the scenario timed out looking for an element that was there all along.
That was a real bug, found by writing the test.

Two matches without `nth` is `E_IOS_AMBIGUOUS`, naming the count and a bounded sample, for the
reason it is on every other surface: taking the first of three matches is how a scenario passes
while driving the wrong control.

## Known limits

1. **Taps are coordinates**, computed as the integer centre of the element frame, and there is no
   z-order modelling. Same limit, same reason, as Android.
2. **`clear`, `swipe`, `press_key`, `scroll_until_visible` and `select_option` are not implemented
   yet.** They refuse with `E_IOS_OP_NOT_IMPLEMENTED` naming the op, rather than no-opping.
3. **The accessibility tree source is the CI harness**, not something Attest ships. On a host
   without one, `E_IOS_ACCESSIBILITY_UNAVAILABLE` says so.
