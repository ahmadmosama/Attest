# Driving a real app: Snapfit

Everything in `examples/` before this was a fixture written to be testable.
[Snapfit](https://github.com/ahmadmosama/Snapfit) is a real app that ships iOS, Android and web
from one codebase, and pointing Attest at it is what actually tested the binding layer's central
claim: **one set of scenario files, three surfaces, no platform detail anywhere in the scenario.**

It also found four bugs that the fixtures could not, one of them in Attest itself and of exactly
the kind this project exists to prevent.

## The result

```text
snapfit.navigate      [web] pass   [android] pass
snapfit.size_profile  [web] pass   [android] pass
```

Web against a production `next start` build in real Chrome. Android against a real debug APK on a
real emulator, with checkpoint screenshots of the actual screens. iOS runs on the macOS runner,
see "The third surface" below.

Two binding files, `android.yaml` and `ios.yaml`, differ **only in their `surface:` line**, and a
test enforces that. `web.yaml` differs in two more places, both because the app genuinely differs
rather than because a locator was worked around.

## What it could not do at the start

Snapfit had **zero** test identifiers, on any surface. Attest's two portable locator strategies
both land on `accessibilityIdentifier` / `resource-id` / `data-testid`, so there was nothing to
bind to. That is the first thing to check before pointing Attest at anything: an app with no
stable identifiers is not testable by any black box tool, and adding them is the app's job.

In React Native a `testID` becomes `accessibilityIdentifier` on iOS and `resource-id` on Android;
on the web it is `data-testid`. **The same string on all three**, which is what makes one scenario
file drive all of them. Snapfit's size fields already shared their keys (`chestCm`, `waistCm`), so
those lined up for free.

Two things went beyond bare identifiers, for the same reason: the selected tab and the busy state
of the submit buttons were expressed **only as a colour**. A test that reads "which tab is active"
from a style breaks on the next redesign, so those now set `accessibilityState` / `aria-selected`.

## The four bugs

**1. `fill` appended instead of replacing, on Android.** The worst one, because the scenario
PASSED. `input text` types at the cursor and `fill` never cleared first. The scenario filled chest
with `98` and waist with `82`, both steps passed, and the checkpoint screenshot showed `9898` and
`8282`, because the app's defaults were already 98 and 82.

Nothing in the run said anything was wrong. Nothing asserted the resulting value. **A screenshot
did.** That is the whole argument for capturing evidence on passing runs, made by accident.

The scenario was wrong too, and that is the deeper lesson: it filled `98` into a field whose
default was `98`, so it could not have caught this even in principle. It now writes values that
differ from the defaults and asserts each one afterwards.

**2. `expect_text` on a form field read inner text, on web.** An input's inner text is always
empty, so the assertion compared against `""` and timed out whatever had been typed. On Android,
uiautomator exposes an `EditText`'s contents as its `text`, so the same op worked there and could
never work here. One op meaning two things is precisely what the binding layer exists to prevent.

**3. The web app had no way to reach the size screen directly.** The mobile app has declared
`scheme: "snapfit"` since it shipped; the web app kept the tab in React state, so a link to "my
size" was impossible to send anyone. Found by trying to `open: screen:size` and discovering there
was nowhere to open. It lives in the URL as `?tab=` now.

**4. The mobile app ignored the deeplink it already declared.** Same discovery from the other
side: the OS had been handing `snapfit://size` to Snapfit all along and Snapfit opened on "find"
regardless, which is worse than not being linkable at all.

Bugs 3 and 4 are the interesting pair. Neither is a testing problem. Both are real product defects
that surfaced because a test tried to reach a screen the way a user with a link would.

## Traps in the setup, all of which cost time

- **Verify against a production build, not a dev server.** The first web run timed out at 30s
  because Next compiles a route on first request. A run against `next dev` measures the dev
  server.
- **Do not let a dev server and a build run at once.** `next build` while `next dev` held `.next`
  produced a broken production build that failed with `MODULE_NOT_FOUND` on a webpack runtime.
- **`expo prebuild` output is generated.** `android/` and `ios/` are gitignored, because
  committing them silently converts a managed Expo project to the bare workflow and `app.json`
  stops being the source of truth. Native config changes belong in `app.json`, through a config
  plugin.
- **Pin Kotlin through `expo-build-properties`.** The build failed after 13 minutes on a
  Compose/Kotlin mismatch, because `expo-modules-core` reads `rootProject.ext.kotlinVersion` and
  falls back to its own hardcoded version when it cannot see one. Hand editing
  `android/build.gradle` would have been discarded by the next prebuild.
- **A debug APK loads its JS from Metro**, so Metro has to be running and `adb reverse tcp:8081`
  set. Adding a dependency after the APK is built fails at runtime with `Cannot find native
  module`, because the native side is in the APK: the APK has to be rebuilt.
- **Git Bash rewrites `/sdcard/ui.xml` into `/Files/Git/sdcard/...`.** Only an issue for ad hoc
  `adb shell` from a shell; Attest's own adapter spawns argv directly and never goes through one,
  which is why it is immune.

## The third surface

`.github/workflows/ios.yml` carries a `snapfit` job that builds Snapfit for the simulator and runs
the same scenario files through idb. It is conditional on a token, because both repositories are
private and the default `GITHUB_TOKEN` reaches only the repo running the workflow.

The adapter conformance job blocks **unconditionally**, so the iOS surface itself is never
unverified. What is conditional is only this extra proof against a second repository.

```bash
gh secret set SNAPFIT_TOKEN --repo ahmadmosama/Attest      # fine grained PAT, read on Snapfit
gh variable set SNAPFIT_VERIFY --body true --repo ahmadmosama/Attest
```

## Reproducing the local half

```bash
# web
cd Snapfit/apps/web && npx next build && npx next start -p 3210 &
cd Attest && node src/cli/main.mjs run \
  --scenarios "examples/snapfit/scenarios/*.attest.yaml" \
  --bindings examples/snapfit/bindings --surface web --app http://127.0.0.1:3210

# android
cd Snapfit/apps/mobile && npx expo prebuild --platform android && \
  (cd android && ./gradlew assembleDebug) && npx expo start &
adb install -r android/app/build/outputs/apk/debug/app-debug.apk && adb reverse tcp:8081 tcp:8081
cd Attest && node src/cli/main.mjs run \
  --scenarios "examples/snapfit/scenarios/*.attest.yaml" \
  --bindings examples/snapfit/bindings --surface android \
  --app <apk> --android-package com.snapfit.app --android-activity .MainActivity \
  --android-serial emulator-5554
```

## Why this repository is public

Standard GitHub-hosted runners are free and unlimited on public repositories. On a private one
they are metered, and macOS bills at **10x**: a 2,000 minute monthly allowance is really 200 macOS
minutes, and this project burned 767 of them in a single afternoon of CI iteration.

Making the harness public removes that ceiling permanently instead of rationing around it, on all
three runner families at once.

Two things had to be true first:

1. **The history, not just the current files.** `git log -p` on a public repository shows every
   blob ever committed, so scrubbing only `HEAD` would have been theatre.
2. **`.planning/` is a private working record.** It is where every leak came from: an employer
   name, a container belonging to an unrelated project, an inventory of private side projects.
   Three rounds of targeted scrubbing each found more, which is the signal that the directory as a
   whole was never written for an audience. It is no longer tracked, stays on disk, and keeps
   working locally. Only `REQUIREMENTS.md` is published, because `src/selfverify/corpus.mjs` reads
   it to validate requirement ids.

`codemagic.yaml` in the Snapfit repo remains as a fallback: 500 free macOS minutes a month on a
personal account, counted 1:1, useful if this repository ever goes private again.
