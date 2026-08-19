#!/usr/bin/env node
/**
 * A reachability and health sweep across many deployed apps.
 *
 * This is the pass that runs BEFORE writing a scenario for anything. Attest
 * proves an app behaves as specified; this answers the cheaper question that has
 * to be true first: is it up, does it render, and does it break on load?
 *
 * Runs against LIVE URLs, so it needs no clone, no install, no env and no CI.
 *
 * WHAT THE FIRST VERSION GOT WRONG, because it matters more than what it got
 * right: it settled for 2.5s and counted ANY console 404 as a failure, and so
 * reported 20 of 24 apps broken. Nearly all of those were healthy. A favicon
 * that 404s, an auth-gated `/api/status` returning 401 to a logged-out visitor,
 * and a React app that had not finished hydrating all looked identical to a
 * dead deploy.
 *
 * A health check that cries wolf is worse than none, because the one real
 * failure is now buried in nineteen false ones. So this version:
 *
 *   - waits for the network to settle, then a beat longer
 *   - judges FAILED REQUESTS BY RESOURCE TYPE. A document or script that will
 *     not load is fatal; an image or an XHR is not, because a logged-out user
 *     hitting an authenticated endpoint is correct behaviour, not a bug
 *   - recognises a login wall as a login wall rather than as an empty page
 *   - reports CSP violations separately: they are real misconfigurations worth
 *     fixing, and they rarely stop the app working
 */

import { chromium } from "playwright";

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 3_000;
const MIN_MEANINGFUL_TEXT = 60;

// Resource types where a failure means the app cannot work. An image or a
// fetch/xhr failing is frequently correct (a logged-out visitor, a lazy asset).
const FATAL_RESOURCE_TYPES = new Set(["document", "script", "stylesheet"]);

// ...but not every script is the app. Analytics, telemetry and tag managers 404
// all the time on projects where the feature was never enabled, and the app is
// completely fine without them. Treating those as fatal reported a healthy site
// (zajelai, 4,439 chars of rendered content) as broken because Vercel Insights
// was not turned on.
const NON_ESSENTIAL_SCRIPT = /insights|analytics|gtag|googletagmanager|hotjar|clarity|sentry|posthog|vitals/i;

const DEAD_MARKERS = [
  { re: /this deployment (cannot be found|has been deleted)/i, label: "deployment deleted" },
  { re: /404: NOT_FOUND|DEPLOYMENT_NOT_FOUND/i, label: "deployment not found" },
  { re: /Application error: a client-side exception/i, label: "client-side exception" },
  { re: /Internal Server Error/i, label: "internal server error" }
];

const AUTH_MARKERS =
  /\b(sign in|log ?in|sign up|continue with|magic link|send sign-in link|email me a link|authenticate)\b/i;

function classify({ status, title, text, fatalRequests, pageErrors, cspViolations, requiresAuth, serviceWorkerBroken = false, nonEssentialFailures = [] }) {
  if (requiresAuth) {
    return { verdict: "auth_wall", note: "Vercel SSO protected, not checkable anonymously" };
  }
  if (status === 0) {
    return { verdict: "unreachable", note: "no response" };
  }
  if (status >= 500) {
    return { verdict: "server_error", note: `HTTP ${status}` };
  }
  if (status === 404) {
    return { verdict: "not_found", note: "HTTP 404" };
  }

  for (const { re, label } of DEAD_MARKERS) {
    if (re.test(text)) {
      return { verdict: "broken", note: label };
    }
  }

  // A script or stylesheet that will not load means the app is genuinely down,
  // whatever the HTML status said.
  if (fatalRequests.length > 0) {
    return { verdict: "broken", note: `${fatalRequests.length} fatal asset failure(s): ${fatalRequests[0]}` };
  }

  // An uncaught exception is the app breaking, as opposed to a console.error.
  if (pageErrors.length > 0) {
    return { verdict: "js_exception", note: pageErrors[0].slice(0, 100) };
  }

  const body = text.trim();
  if (body.length < MIN_MEANINGFUL_TEXT) {
    return { verdict: "renders_nothing", note: `${body.length} chars after settle` };
  }

  // Reaching a login screen is a healthy app, not a broken one. It does mean an
  // unauthenticated scenario cannot go deeper without credentials.
  if (AUTH_MARKERS.test(body) && body.length < 900) {
    return { verdict: "ok_login_wall", note: title || "login screen" };
  }

  if (serviceWorkerBroken) {
    return { verdict: "ok_sw_broken", note: "renders, but the ServiceWorker will not register (offline support is dead)" };
  }

  if (nonEssentialFailures.length > 0) {
    return { verdict: "ok_analytics_404", note: `renders, ${nonEssentialFailures.length} analytics/telemetry script 404` };
  }

  if (cspViolations > 0) {
    return { verdict: "ok_csp_warnings", note: `renders, ${cspViolations} CSP violation(s) worth fixing` };
  }

  return { verdict: "ok", note: title || "renders" };
}

async function checkOne(browser, { name, url }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const pageErrors = [];
  const fatalRequests = [];
  const nonEssentialFailures = [];
  let cspViolations = 0;
  let serviceWorkerBroken = false;

  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
      cspViolations += 1;
    }
  });
  page.on("pageerror", (error) => {
    const message = String(error?.message ?? error);
    // A ServiceWorker that will not register breaks offline support, not the
    // page: the app renders and works. Recorded as a warning, not a failure.
    if (/ServiceWorker/i.test(message)) {
      serviceWorkerBroken = true;
      return;
    }
    pageErrors.push(message);
  });
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (response.status() >= 400 && FATAL_RESOURCE_TYPES.has(type)) {
      if (NON_ESSENTIAL_SCRIPT.test(response.url())) {
        nonEssentialFailures.push(response.url().slice(0, 70));
      } else {
        fatalRequests.push(`${type} ${response.status()} ${response.url().slice(0, 70)}`);
      }
    }
  });

  let status = 0;
  let title = "";
  let text = "";
  let testIds = 0;
  let requiresAuth = false;

  try {
    const response = await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    status = response?.status() ?? 0;
    requiresAuth = status === 401 || page.url().includes("vercel.com/sso");

    // Settle, then a beat longer. Hydration finishing is the difference between
    // "renders nothing" and the real page.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);

    title = await page.title().catch(() => "");
    text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    testIds = await page.locator("[data-testid]").count().catch(() => 0);
  } catch (error) {
    await context.close().catch(() => {});
    return {
      name,
      url,
      status,
      testIds,
      cspViolations,
      verdict: status === 0 ? "unreachable" : "load_failed",
      note: String(error?.message ?? error).split("\n")[0].slice(0, 90)
    };
  }

  await context.close().catch(() => {});
  return {
    name,
    url,
    status,
    testIds,
    cspViolations,
    serviceWorkerBroken,
    nonEssentialFailures: nonEssentialFailures.length,
    ...classify({ status, title, text, fatalRequests, pageErrors, cspViolations, requiresAuth, serviceWorkerBroken, nonEssentialFailures })
  };
}

export async function sweep(targets, { concurrency = 4 } = {}) {
  const browser = await chromium.launch({ channel: "chrome" });
  const results = [];
  const queue = [...targets];

  async function worker() {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const result = await checkOne(browser, next);
      results.push(result);
      const healthy = result.verdict.startsWith("ok");
      process.stdout.write(
        `  ${healthy ? "ok  " : "FAIL"} ${result.name.padEnd(24)} ${result.verdict.padEnd(16)}` +
          `${String(result.testIds).padStart(4)} testids  ${result.note}\n`
      );
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await browser.close();
  return results.toSorted((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write("usage: live-sweep.mjs <targets.json>\n");
    process.exit(2);
  }

  const { readFile, writeFile } = await import("node:fs/promises");
  const targets = JSON.parse(await readFile(file, "utf8"));
  process.stdout.write(`sweeping ${targets.length} live apps\n\n`);
  const results = await sweep(targets);

  const counts = new Map();
  for (const result of results) {
    counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  }

  process.stdout.write("\nsummary\n");
  for (const [verdict, count] of [...counts].toSorted((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${String(count).padStart(3)}  ${verdict}\n`);
  }

  await writeFile("live-sweep-results.json", `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write("\nwrote live-sweep-results.json\n");
}
