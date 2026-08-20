# Portfolio QA: durable state

The work queue for getting the portfolio to "works as expected, no design
defects, production ready". Written to disk deliberately: this is more work than
fits in one context, so progress lives here rather than in a conversation, and
any session can resume by reading this file.

Updated 2026-08-20.

## What has actually been verified, and what has not

Being precise about this matters more than the backlog itself, because the
easiest way to ship a broken portfolio is to believe it was tested.

| Layer | State |
|---|---|
| Every app loads and renders | **verified**, real browser, all 24 |
| Homepage smoke scenario | **verified**, 22 of 24 pass (2 have no `<h1>` to anchor) |
| Homepage audit: a11y, mobile width, broken images, dead links, meta | **verified**, all 24 |
| Any route other than `/` | **not tested**, except Nest `/search` |
| Sign up, sign in, any authenticated view | **not tested** anywhere |
| Any form submission, search, or write path | **not tested** anywhere |
| Database state after an action | **not tested** anywhere |
| iOS / Android builds | **not tested**, except Snapfit |
| Error, loading and empty states | **not tested** anywhere |

A green smoke suite means "the front door opens". It does not mean the app
works, and the two must not be confused in a report.

## Fixed and deployed

| App | Defect | Verified |
|---|---|---|
| dialect | CSP blanked the whole site: nonce nothing applied blocked Next's bootstrap, React never started | prod: 0 -> 1727 chars, 0 CSP violations |
| dialect | no `viewport` meta, so phones rendered at desktop width | prod: present |
| nest | `/search` map collapsed to height 0, right half of the page blank | prod: map 0 -> 731px, 23 markers |
| nest | dead Unsplash id, 10 occurrences, 2 visible as broken cards | prod: 0 broken images |
| depth + zeeja | homepage scrolled sideways 215px on every phone: auto-sized grid column | local: 215px -> 0, same content length |
| backtrack | scrolled sideways 51px on a phone: same grid cause plus an unwrappable flex header | local: 51px -> 0, same content length |

## Open, verified, not yet fixed

Ordered by user impact.

| # | App | Defect | Severity |
|---|---|---|---|
| 1 | khayat | 452x603 panel renders empty: its `repeating-linear-gradient` with `oklch()` is rejected by the browser, so the texture never paints | high |
| 4 | sufra-admin, jarvis, productivity-musl | form fields with no label | medium |
| 5 | dialect, consultalyst, professional-feedback, jarvis | buttons with no accessible name | medium |
| 6 | jarvis | no `<h1>` | medium |
| 7 | 22 apps | no `og:image`, so every shared link previews blank | low, but portfolio wide |
| 8 | backtrack | 56 CSP violations blocking OpenStreetMap tiles | needs re-check after the tile work |

## Not yet started

| Scope | Why it matters |
|---|---|
| Routes beyond `/` on 23 apps | Nest's worst bug was on `/search`, not `/`. The homepage is the least likely page to be broken |
| Authenticated flows | 5 apps are login walls; everything behind them is unverified |
| Mobile surfaces | sufra, language-assistant, kith-mobile, depth-app, hfd, JobWatcher-f all ship a mobile app. Only Snapfit has been driven |
| Functional scenarios with value assertions | The Snapfit `fill` bug passed a scenario while writing `9898` into a field. Characterisation tests cannot catch that class |

## How to resume

```bash
cd "C:/Users/ahmad/Desktop/Claude/Attest"
node tools/live-sweep.mjs targets.json     # is anything down
node tools/deep-audit.mjs targets.json     # current defect list
bash tools/run-portfolio.sh                # smoke scenarios, all apps
```

Every fix follows the same loop, and the last step is not optional: reproduce
against the live app, fix, rebuild locally, verify the measurement changed,
push with `[skip ci]`, then verify again in production.
