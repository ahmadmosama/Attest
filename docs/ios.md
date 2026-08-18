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
| idb argv construction | yes, committed transcripts | yes |
| normalising a real idb accessibility tree | yes, committed transcript of real output | yes |
| the .app versus .ipa refusal | yes | yes |
| a real simulator booting | no | yes |
| idb reaching a live companion | no | yes |
| real taps and typing landing on a real app | no | yes |

The last three are the honest gap on THIS host. `preflight` refuses with `E_IOS_NO_SIMULATOR`
naming the macOS runner, rather than pretending a simulator might appear. All three are now
proven on the runner: ios.yml has been green since 2026-08-18.

## The driver: idb

`simctl` boots, installs and launches. It has no accessibility tree and no tap, so on its own the
surface can start an app and then not touch it. The UI half comes from
[`facebook/idb`](https://github.com/facebook/idb), Meta's iOS Development Bridge.

It was picked the way the Android driver was, by asking what actually exists:

| Candidate | Verdict |
|---|---|
| **`facebook/idb`** | **Adopted.** 5.3k stars, pushed the same week it was evaluated, not archived, MIT. One binary, argv only, no server to host per run, and an accessibility tree carrying `AXUniqueId` |
| `appium/WebDriverAgent` | Maintained, but it is an XCUITest server that must be built and hosted per run, and it arrives with the Appium stack this project already declined for Android (decision C6) |
| `facebookarchive/WebDriverAgent` | Archived in 2019 |
| `wix/AppleSimulatorUtils` | Permissions and media only, no UI tree |
| `cameroncooke/XcodeBuildMCP` | An MCP server for agents, not a test backend |

idb is the iOS analogue of adb, which is exactly why it wins here: it is the same shape as the
backend Android already uses, so the two mobile surfaces are one idea twice rather than two.

**The command layer is pure.** `src/surfaces/ios/idb.mjs` builds argv and normalises responses and
spawns nothing, so all of it is asserted on Windows against a committed transcript of real idb
output. `src/surfaces/ios/backend.mjs` fills the adapter's three seams with those commands.

Three things it enforces that are worth naming:

- **argv only, never a string.** Same reason as adb: a string needs a shell, and a shell is what
  makes argument injection possible. Unlike the adb path there is no *device side* shell either,
  so `idb ui text` takes the text as one argument and quoting it would type the quotes.
- **A udid is mandatory, never defaulted.** idb will happily target "the only booted simulator".
  On a runner with two of them that is a green run against a simulator nobody chose.
- **Unparseable output is refused, not coerced to `[]`.** An empty tree and a broken companion are
  different facts, and flattening them reports "the element is not there" for a dead companion,
  which sends whoever is paged to the wrong place entirely.

Installing it needs **both halves**: `idb-companion` is the native process that talks to
CoreSimulator, `fb-idb` is the Python CLI that talks to the companion. Installing one and not the
other fails at the first `ui` command, not at install time, so the workflow asserts
`idb ui describe-all` succeeds against the booted device before the suite runs.

## What the first five CI runs taught

`ios.yml` was written before it had ever run. It went green on the fifth attempt, and every
failure in between was a real fact rather than a guess. Worth recording, because four of the five
were things no amount of local care would have found.

| Run | Failed at | What it actually was |
|---|---|---|
| 1 | runtime assertion | Xcode 26.1.1 was installed and pinned fine; the **iOS 26.1 runtime was not on the image at all** (it ships 26.2, 26.4, 26.5). Runner image issue 13853's pattern, inverted |
| 2 | `brew install idb-companion` | Homebrew now **refuses formulae from untrusted third party taps**. Most idb install instructions still omit `brew trust` |
| 3 | first `idb` invocation | fb-idb 1.1.7 calls `asyncio.get_event_loop()`, which **raises on Python 3.14** (the image's Homebrew python). Installed cleanly, died on every call |
| 4 | `idb ui describe-all` | "No translation object returned for simulator". `simctl bootstatus -b` returns when the **system** booted; the accessibility tree serving is a different readiness condition |
| 5 | nothing | green. 40 tests, 40 pass |

Two things are worth taking from that table.

**The pre-suite guards earned their place twice.** Runs 1 and 4 both failed in a step named for
what it checks, with a sentence, before a single scenario ran. Without them, run 1 would have been
a confusing `simctl create` error and run 4 would have looked like every locator in the suite had
broken at once. The rule those guards encode, that infrastructure must be distinguishable from a
scenario failure, is the same one the runtime holds at every other layer.

**The exact pin was the wrong shape, not the wrong number.** Fixing run 1 by writing `26.5`
instead of `26.1` would have bought one image rotation. The floor plus "report what was actually
selected into the job summary" is the version that survives, because the thing worth preventing
was silent drift, not drift. The same reasoning is now in the Windows job, which discovers its
PostgreSQL service instead of hardcoding `postgresql-x64-17`.

Run 4's fix is the one that reads most like the rest of the project: converge on the real signal
with a bounded budget rather than sleeping a guessed duration. It needed 2 attempts on the run
that went green, so it was load bearing and not defensive padding.

## The .app versus .ipa contract

Attest takes a **simulator `.app` bundle**, a directory or that directory zipped. It never takes
a device `.ipa`, because a simulator cannot install one. Passing an `.ipa` is refused with the
whole explanation rather than a confusing failure later:

```text
E_IOS_DEVICE_ARTIFACT  'build/Runner.ipa' is a device build. The iOS Simulator cannot install a
device .ipa. Build for `generic/platform=iOS Simulator` and pass the resulting .app bundle
(a directory, or that directory zipped) instead.
```

## Floors, not pins

The workflow declares a **minimum** for both halves of the toolchain, takes the newest thing at or
above it, and reports what it took:

```yaml
env:
  IOS_RUNTIME_MIN: "26.2"
  XCODE_MIN: "26.1"
```

This started as an exact pin of both, on the reasoning that trusting the image default is how a
green job stops meaning anything: runner image issue 13853 had Xcode shipping ahead of its
matching simulator runtime. Run 1 above showed the pin was the wrong shape. An exact pin breaks on
every image rotation, and that treadmill ends one way, with somebody deleting the pin and going
back to the default.

What is actually worth preventing is *silent* drift, so the selected Xcode and runtime go into the
job summary and into the run's environment. A green job still means something, because you can
always read what it ran on.

The selection is `tools/select-ios-runtime.mjs`, not inline shell, so its parsing is asserted on
Windows against the exact listing the real image returned. It returns the runtime's **identifier**,
never a string rebuilt from a version: "iOS 26.4" reports version `26.4.1` and identifier
`iOS-26-4`, so reconstructing gives `iOS-26-4-1` and `simctl create` fails with "invalid runtime".

The assertion still runs first, so a toolchain that cannot satisfy the floor fails with a sentence
naming what is missing and what is present, rather than with a simctl error thirty steps later.

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
3. **idb is not vendored.** It is installed on the runner, and on a host without it the backend
   refuses with `E_IDB_UNAVAILABLE` carrying the two install commands, rather than reporting a
   locator miss.
4. **The `.app` still has to be built somewhere.** idb installs and drives a simulator build; it
   does not produce one. That is the macOS runner's job, and it is why there is no offline iOS
   fixture the way there is an offline fixture APK for Android.
