# Android Surface

The Android surface runs the same scenarios the web surface runs, against an APK installed on
an emulator or a device. It drives `adb` directly rather than Appium. That decision is C6 in
`.planning/REQUIREMENTS.md` and the reasoning is recorded there, not repeated here.

## Setup

Nothing in Attest installs the SDK. What has to exist:

| Thing | How Attest finds it |
|---|---|
| `adb` | `ANDROID_HOME` or `ANDROID_SDK_ROOT`, then `%LOCALAPPDATA%\Android\Sdk`, then `~/Android/Sdk`. PATH is never consulted |
| `emulator` | the same roots, under `emulator/` |
| an AVD | `android.avd` in the config, or `ATTEST_ANDROID_AVD` |
| a device | `android.serial`, or `ATTEST_ANDROID_SERIAL`, or exactly one attached device |

PATH is deliberately not consulted for either binary. On this machine `java` is not on PATH at
all, and resolving tools from the SDK root is what keeps a run reproducible.

## Configuration

```json
{
  "app": "build/app.apk",
  "surfaces": ["android"],
  "android": {
    "avd": "attest_pixel7_a35",
    "serial": null,
    "package": "com.example.app",
    "activity": ".MainActivity",
    "install": true,
    "record": true,
    "bootTimeoutMs": 180000,
    "recordSeconds": 180,
    "extras": { "api_base": "http://10.0.2.2:8080" }
  }
}
```

`android.package` is required and is never inferred from the APK. Reading the manifest would
need `aapt`, and guessing the package is how a run force stops or launches the wrong app and
then reports a locator failure that has nothing to do with the app under test.

`android.extras` becomes `--es key value` on every activity start. That is how an app under
test is told something that only exists at run time, such as the ephemeral port a local
fixture server bound to.

## Device lifecycle

One emulator per run, not one per scenario.

`createDeviceLease` resolves the device once and every scenario borrows it:

- an explicit serial attaches, and is never started or stopped by Attest
- no serial plus an AVD starts that AVD, gates on boot, and stops it when the run ends
- no serial and no AVD uses the single attached device, or refuses when there are zero or more
  than one, naming what it found

Boot gating reads `sys.boot_completed` and `dev.bootcomplete`. `adb wait-for-device` is not the
gate: it returns as soon as adbd answers, which happens long before the package manager can
install anything, so a run that started there would fail on the first tap and look like a
scenario bug.

An emulator that will not boot raises `E_EMULATOR_BOOT_FAILED`, an `InfraError`, carrying a
remediation hint. It is never reported as a failing scenario.

The run command shuts the lease down in a `finally`, so an emulator this run started is stopped
even when the run throws. A leaked emulator breaks the NEXT run rather than this one, because
only one instance of an AVD can be started at a time.

## Capabilities

`src/surfaces/android/capabilities.mjs` declares exactly two:

```text
app_lifecycle
raw_escape
```

Everything else is absent rather than degraded, and each absence is a thing plain adb cannot do
correctly:

| Capability | Why it is absent |
|---|---|
| `file_upload` | `adb push` moves a file onto the device but does not answer the app's picker intent |
| `network_control` | `svc wifi disable` needs privileges a shell user does not have on a `google_apis` image, and the emulator console port needs an auth token |
| `permission_control` | `pm grant` takes a manifest declared runtime permission, and the scenario vocabulary is browser shaped. Mapping between them is a per app guess, and a wrong guess grants nothing while reporting success |
| `clipboard_control` | no stable shell surface across API levels |
| `clock_control` | needs root on a user build |

An op demanding an undeclared capability raises `E_UNSUPPORTED_OP` naming what is missing, or
lowers to an explicit skip. It is never silently no-opped.

## Locators

Bindings live in `bindings/<app>/android.yaml`. The scenario file is not edited between
surfaces: only the binding file changes.

| Strategy | Android meaning |
|---|---|
| `testId` | `resource-id`, matched exactly or by the `:id/<value>` suffix, because Android resource ids are package qualified and a binding is not |
| `accessibilityId` | `content-desc`, exact |
| `role` plus `name` | an explicit class allowlist per role, plus the name matched against `text` or `content-desc` |
| `nth` | the declared way to choose among several matches |
| `within` | a `testId` container whose bounds must contain the candidate's bounds |
| raw `css`, `xpath`, `uiautomator`, `predicate` | refused with `E_RAW_SELECTOR_KIND` |

Raw selectors are refused rather than approximated. The adb backend has no selector engine, and
approximating a query against a dumped tree is guessing about which widget to drive.

**Two matches is an error.** `E_ANDROID_AMBIGUOUS` names the match count and a bounded sample of
what matched. Taking the first of three matches is how a scenario passes while driving the
wrong widget.

Roles map to simple class names, so one declared role covers `Button`, `AppCompatButton` and
`MaterialButton` without the binding knowing which support library the app was built against.
An unknown role raises `E_ANDROID_ROLE_UNSUPPORTED` and names the accepted set.

Screens are reached by `deeplink`, never by `path`. Attest always passes the component with
`-n` as well, so the intent resolver never gets to put a chooser dialog in front of the app.

## The device shell, and why `input text` is quoted

The host side never sees a shell. Every invocation is an argv array handed to the native binary
with `shell: false`, which is DROID-03 and is what makes the Git Bash path rewriting trap
recorded in ENV-VERIFIED structurally impossible.

The device side is different and cannot be avoided: `adb shell` joins the argv with spaces and
hands the result to `/system/bin/sh` on the device. So `input text hello world` types only
`hello`. Free text and deeplink URIs are single quoted for the device shell in
`src/surfaces/android/commands.mjs`. Everything else is validated against a pattern with no
spaces and no metacharacters, so nothing else needs quoting. A newline in text is refused rather
than escaped, because a scenario that wants to send Enter has `press_key`.

Evidence never goes through a host path at all. `screencap` and the hierarchy dump come back
through `exec-out`, on stdout.

## Evidence

| Artifact | When |
|---|---|
| `evidence/step-N-checkpoint-<label>.png` | every checkpoint |
| `evidence/failure.png` | a failed scenario |
| `evidence/failure-hierarchy.xml` | a failed scenario, redacted |
| `evidence/recording.mp4` | a failed scenario only |

Recording starts at session open and is discarded on a pass. A recording that only starts once
a step has failed has already missed the failure.

The hierarchy dump carries whatever text the app rendered, which can include a token, so it is
redacted at capture time rather than at publication time. That is the same rule the web adapter
follows for a HAR.

`SIGINT`, not `SIGKILL`, stops the recording: `screenrecord` finalises the mp4 container on
interrupt, and a killed recording leaves an unplayable file, which is evidence that looks
present and is not.

## A tap is fire and forget, so assert before closing a delta window

This is the single thing most likely to waste an afternoon, and it was found the hard way.

`input tap` returns as soon as the touch is dispatched. The app's own work, an HTTP call and a
database write, is still in flight. A change window is fenced by watermark rows and the close
marker is written **before** the close converges, so a write that lands after the marker falls
outside the fence and is invisible to the delta. The run then reports the mutation as missing
while the row plainly exists in the database.

The fix is a step, not a setting:

```yaml
- tap: button:create_order
- expect_text: { target: state:status, equals: "order created" }   # <- this
- delta_window: close
```

The assertion converges on a real signal from the app, which is exactly why `sleep` is banned.
On web this is mostly free, because Playwright's `click` already waits for actionability and the
navigation that follows. On Android nothing waits for you.

## Known limits, stated rather than hidden

1. **Taps are coordinates.** The tap point is the integer centre of the node's dumped bounds.
   That is cruder than a W3C element click and more sensitive to layout change. It is the
   recorded cost of decision C6.
2. **`screenrecord` stops at 180 seconds.** A longer scenario keeps the first 180 seconds and
   the artifact records `truncated: true`. Chunked recording is not implemented.
3. **No network control, no permission control, no clipboard, no clock.** See the capability
   table above. Each is absent, not faked.
4. **`clear` deletes one character at a time**, in a single `input keyevent` call, and refuses a
   field holding more than 200 characters rather than sending an unbounded key list.
5. **`select_option` taps the control and then taps the option by its text.** It relies on the
   opened list being in the hierarchy, and ambiguity is refused as everywhere else.
6. **Only one instance of an AVD can run at a time.** A crashed run that left an emulator
   booting will make the next `startEmulator` wait for a serial that never appears, because the
   second launch is refused. Check `adb devices` and for stray `qemu-system-x86_64` processes
   before blaming the code.
7. **Attest does not model z order.** A node underneath an overlay, an ActionBar, a snackbar, a
   bottom sheet scrim, still reports its own bounds in the dump, so the tap lands on the overlay
   instead. This was hit for real while building the fixture: with the default theme the
   ActionBar is drawn over the content and the first button's centre fell underneath it. The tap
   succeeded, the app did nothing, and the next assertion failed. The diagnosis is in the bundle:
   the failure screenshot shows the untouched screen and the hierarchy dump shows the overlay's
   bounds covering the button's centre.
8. **Material buttons uppercase their label.** `setText("Create order")` dumps as
   `CREATE ORDER`, so a `role` plus `name` binding has to match what the theme renders, not what
   the source says. Binding by id sidesteps it, which is the recommended path anyway.

## The fixture APK

`fixtures/self-verify/android` is a minimal native app that talks to the same fixture HTTP
server the web scenario drives, so the same Postgres delta assertions run on mobile.

```bash
node tools/build-fixture-apk.mjs           # writes .attest/fixture/attest-selfverify.apk
```

The build uses `aapt2`, `javac`, `d8`, `zipalign` and `apksigner` from the installed SDK and the
Android Studio JBR. There is no Gradle and no network access: Gradle resolves the Android Gradle
Plugin from Google Maven on a cold build, which would put a network dependency in the critical
path of a fixture whose whole job is to be deterministic.

Two details that are load bearing:

- The app is **native, not a WebView**. A WebView exposes a degraded accessibility tree with no
  resource ids, which would make the Android locator work look like it succeeded while it was
  really matching on text alone.
- Its ids are **declared in `res/values/ids.xml`**, not assigned with `setId(1234)`. uiautomator
  reports `resource-id` from the resource name, so a programmatic id dumps as empty.

## Running it

```bash
export ATTEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres"
export ATTEST_DB_URL="$ATTEST_PG_URL"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"

node tools/build-fixture-apk.mjs
node --test test/acceptance/phase-05-android.test.mjs
```

With no device attached the live criteria skip and print what was not proven. A gate that
quietly passes on a missing emulator is the exact failure mode this project exists to refuse.

## The milestone demo

One command runs one real app on the Android emulator, drives it, and leaves an evidence
bundle. Reproduced 2026-08-17 against `attest_pixel7_a35` (API 35) and PostgreSQL 17.6.

```bash
# 1. build the APK, offline
node tools/build-fixture-apk.mjs

# 2. start the fixture HTTP app on a fresh schema, note its port
#    (the emulator reaches the host loopback as 10.0.2.2)

# 3. one command
node src/cli/main.mjs run \
  --scenarios "examples/mobile-demo/scenarios/*.attest.yaml" \
  --bindings examples/mobile-demo/bindings \
  --surface android \
  --app .attest/fixture/attest-selfverify.apk \
  --android-package attest.selfverify \
  --android-activity .MainActivity \
  --android-serial emulator-5554 \
  --android-extra "attest_api_base=http://10.0.2.2:55134"
```

```text
android: real (emulator-5554) .attest/fixture/attest-selfverify.apk
1 scenarios: 1 passed, 0 failed, 0 skipped, 0 infra
+-------------------------+--------------+--------------+----------+
| Scenario                | Surface      | Result       | ms       |
+-------------------------+--------------+--------------+----------+
| mobile_demo.create_ord… | android      | pass         | 13658    |
+-------------------------+--------------+--------------+----------+
HTML report: .attest/runs/20260817T171956Z-6fad1c3d/report.html
```

Verified independently rather than from the runner's own output:

```text
$ psql -tAc "SELECT id, customer_id, status, total_cents FROM p5_demo.orders WHERE id='order_300'"
order_300|cust_a|created|9900

$ psql -tAc "SELECT sku, quantity, unit_cents FROM p5_demo.order_items WHERE order_id='order_300'"
new_lamp|2|3000
new_shade|1|3900

$ ls .attest/runs/20260817T171956Z-6fad1c3d/scenarios/*/evidence/
step-2-checkpoint-customers_loaded.png
step-5-checkpoint-order_created.png
```

No recording on a pass, which is the contract.

Running it a second time against the same schema fails, and the failure is worth showing
because it is what the tool is for. The fixture's create is not idempotent, so the second run
gets a primary key conflict:

```text
Scenario failure: E_TIMEOUT scenario mobile_demo.create_order step 4 step timed out after 30000ms
```

and the bundle names the cause without anyone attaching a debugger:

```text
evidence/failure.png
evidence/failure-hierarchy.xml   <- status_text text="create failed 500"
evidence/recording.mp4
```

The Postgres delta half of the milestone is proven by criterion 2 of
`test/acceptance/phase-05-android.test.mjs`, which runs the same steps with a delta window
around the tap and asserts four expected mutations and zero unexplained ones.
