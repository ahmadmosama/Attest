# Portfolio QA: durable state

The work queue for getting the portfolio to "works as expected, no design
defects, production ready". Written to disk deliberately: this is more work than
fits in one context, so progress lives here rather than in a conversation, and
any session can resume by reading this file.

Updated 2026-08-21.

## What has actually been verified, and what has not

Being precise about this matters more than the backlog itself, because the
easiest way to ship a broken portfolio is to believe it was tested.

| Layer | State |
|---|---|
| Every app loads and renders | **verified**, real browser, all 24 |
| Every discovered route audited, not just `/` | **verified**, 86 routes across 24 apps |
| Audit battery: a11y, phone width, broken images, collapsed maps, dead links, meta | **verified**, every route |
| Target actually serves the app (not an auth wall or error page) | **verified**, guarded in the tool |
| Homepage smoke scenario | **verified**, 22 of 24 |
| Android, driven on a real emulator | **verified**, Snapfit only, 2/2 scenarios |
| iOS, driven on a real simulator | **verified in CI**, Snapfit only, 40/40 on macos-26 |
| Sign up, sign in, any authenticated view | **not tested** anywhere |
| Any form submission, search, or write path | **not tested** anywhere |
| Database state after an action | **not tested** anywhere |
| Mobile surfaces of the other apps | **not tested**: sufra, language-assistant, kith-mobile, depth-app, hfd, JobWatcher-f |
| Error and loading states | **not tested**; one empty state was found broken and fixed |

A green smoke suite means "the front door opens". It does not mean the app
works, and the two must not be confused in a report.

## Current standing

`node tools/crawl-audit.mjs targets-live.json 8`

**24 apps, 86 routes, 0 high findings.** The 5 remaining medium findings all
have fixes pushed and are awaiting a final re-crawl to confirm.

## Fixed and verified in production

| App | Defect | Verified |
|---|---|---|
| khayat, mobilia, cross-boarders, language-assistant, sawa | CSP carried a nonce **and** `'unsafe-inline'` in `style-src`. A nonce makes the browser ignore `unsafe-inline`, and a `style="..."` attribute can never carry a nonce, so every inline style was dropped. `strict-dynamic` in `script-src` also made `'self'` ignored, blocking the apps' own chunks | khayat 12/12 gradients paint (was 0), CSP errors 26 -> 0 on language-assistant, 0 across all five |
| dialect | CSP blanked the whole site: React never started | prod: 0 -> 1727 chars |
| dialect | no `viewport` meta, phones rendered at desktop width | prod: present |
| nest | `/search` map collapsed to height 0, right half of the page blank | prod: map 0 -> 731px, 23 markers |
| nest | dead Unsplash id, 10 occurrences | prod: 0 broken images |
| depth + zeeja | homepage scrolled sideways 215px on every phone | prod: 0px |
| backtrack | scrolled sideways 51px on a phone | prod: 0px |
| cross-boarders | `/travelers` scrolled sideways 6px: a `flex-1` centre column with default `min-width:auto` between two `shrink-0` items | prod: 396 -> 390px, 0 offenders |
| candor | `/workspace` scrolled sideways 300px: a 7 column table forced `main` to 690px. Broken with JS disabled too, so not a hydration flash | prod: 690 -> 390px, table scrolls in its own box, all 7 columns reachable |
| snapfit (Android) | header rendered under the status bar, wordmark drawn on top of the system clock and icons. RN's `SafeAreaView` is iOS only | emulator: status bar on its own row, wordmark clean |
| khayat, language-assistant, sufra-admin, candor, jarvis, borrowed-reach, productivity-musl | 9 unlabelled controls and 2 missing headings | deployed and re-probed |
| dialect, rentals, professional-feedback, candor | last 5 medium findings: unnamed play control, 2 unnamed search controls, 2 missing `h1` | pushed, re-crawl pending |

## Fixed in Attest itself

Every one of these was found by pointing the tool at real apps.

| Fix | Why it mattered |
|---|---|
| Target reachability guard | A target pointed at a Vercel team-scoped URL behind deployment protection. Vercel's login page answered with **HTTP 200**, and five routes were audited and reported as the app with a few minor notes. The app never loaded once and nothing said so. Now a hard failure, checked by host, because the redirect ends on `vercel.com/login` and that page's `<title>` sits past any sane read limit |
| Hidden and off-screen controls excluded | A styled upload button hides a real `<input type=file hidden>`; a spam honeypot is a real input at `-9999px`. Both were reported as unlabelled fields |
| Button names read from `textContent` | `innerText` is layout-dependent and returns `""` for subtrees skipped by `content-visibility`, so a labelled call-to-action 5,636px down the page reported as unnamed |
| `--timeout-preflight` | Preflight installs the APK, so its cost scales with app size. Pinned at 15s with no flag, a 123MB Expo build died as `infra_error` before a single step ran |

## Not yet started

| Scope | Why it matters |
|---|---|
| Authenticated flows | 5 apps are login walls; everything behind them is unverified |
| Write paths and DB assertions | Attest's whole differentiator, unused against these apps |
| Mobile surfaces beyond Snapfit | 6 apps ship one and none have been driven |
| Functional scenarios with value assertions | The Snapfit `fill` bug passed a scenario while writing `9898` into a field. Characterisation tests cannot catch that class |

## How to resume

```bash
cd "C:/Users/ahmad/Desktop/Claude/Attest"
node tools/crawl-audit.mjs targets-live.json 8   # every route of every app
node tools/live-sweep.mjs targets-live.json      # is anything down
bash tools/run-portfolio.sh                      # smoke scenarios
```

Android, against a running emulator. The APK is a debug build, so Metro must be
serving from the app's own directory or the screen stays blank and every step
times out:

```bash
node src/cli/main.mjs run --scenarios "examples/snapfit/scenarios/*.yaml" \
  --bindings examples/snapfit/bindings --surface android \
  --app <apk> --android-package com.snapfit.app --android-activity .MainActivity \
  --timeout-preflight 300000 --timeout-step 300000
```

Every fix follows the same loop, and the last step is not optional: reproduce
against the live app, fix, rebuild locally, verify the measurement changed, push
with `[skip ci]`, then verify again in production.
