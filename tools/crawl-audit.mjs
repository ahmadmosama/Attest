#!/usr/bin/env node
/**
 * Audit EVERY route of an app, not just its front door.
 *
 * The homepage is the least likely page to be broken: it is the one that gets
 * looked at. Nest's worst defect (half of `/search` blank, the map collapsed to
 * zero height) sat one route deep and every homepage-only pass walked straight
 * past it.
 *
 * So this discovers routes and runs the full deep-audit battery on each. It
 * turns a 24-page sweep into a whole-site one, which is the difference between
 * "the front door opens" and "the app is not obviously broken".
 *
 * Read only, and deliberately so:
 *
 *   - GET navigation only. No form submits, no destructive controls.
 *   - Same origin, so an outbound link cannot walk the crawl off the app.
 *   - A route budget per app, so one paginated listing cannot become 10,000
 *     page loads against somebody's hosting.
 *   - Routes are normalised and de-duplicated, so `/x`, `/x/` and `/x#a` are
 *     one page rather than three.
 */

import { chromium } from "playwright";
import { auditApp } from "./deep-audit.mjs";

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 2_000;
const DEFAULT_MAX_ROUTES = 12;

// Paths that log the crawler out, cost money, or are not pages.
const SKIP_PATH = /\/(logout|sign-?out|api|_next|cdn-cgi|checkout|pay|billing|delete)(\/|$)/i;
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|xml|txt|json|css|js|woff2?)$/i;

function normalise(pathname) {
  const withoutHash = pathname.split("#")[0].split("?")[0];
  const trimmed = withoutHash.replace(/\/+$/u, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

/**
 * Routes the app links to, from the pages it links to.
 *
 * One hop from the homepage plus one hop from each of those, which in practice
 * reaches every page a visitor can reach without typing a URL. Deeper crawling
 * costs a lot and finds mostly pagination.
 */
export async function discoverRoutes(browser, url, { maxRoutes = DEFAULT_MAX_ROUTES } = {}) {
  const origin = new URL(url).origin;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const found = new Set(["/"]);

  async function linksOn(pathname) {
    try {
      await page.goto(`${origin}${pathname}`, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(SETTLE_MS);
    } catch {
      return [];
    }

    const hrefs = await page
      .$$eval("a[href]", (nodes) => nodes.map((node) => node.getAttribute("href") ?? ""))
      .catch(() => []);

    return hrefs
      .filter((href) => href.startsWith("/") && !href.startsWith("//"))
      .map((href) => normalise(href))
      .filter((href) => !SKIP_PATH.test(href) && !SKIP_EXT.test(href));
  }

  for (const href of await linksOn("/")) {
    if (found.size < maxRoutes) {
      found.add(href);
    }
  }

  // One more hop, from the first few discovered pages.
  for (const seed of [...found].slice(1, 4)) {
    if (found.size >= maxRoutes) {
      break;
    }
    for (const href of await linksOn(seed)) {
      if (found.size < maxRoutes) {
        found.add(href);
      }
    }
  }

  await context.close().catch(() => {});
  return [...found].toSorted();
}

/**
 * Interstitials that are served with a 200 and are not the app.
 *
 * This exists because of a real miss. One target pointed at a Vercel
 * team-scoped deployment URL, which is covered by deployment protection, so
 * every request was answered by Vercel's own SSO login page — with HTTP 200.
 * The crawler dutifully audited that login page across five routes and
 * reported it as the app with a handful of minor accessibility notes. The app
 * itself was never loaded even once, and nothing in the output said so.
 *
 * A status code is not proof you reached the thing you meant to reach. Fail
 * loudly instead, because a wrong target that reports "mostly fine" is worse
 * than one that reports nothing at all.
 */
const PLATFORM_ERROR = /DEPLOYMENT_NOT_FOUND|DEPLOYMENT_PAUSED|DEPLOYMENT_DISABLED|NOT_FOUND_ERROR/u;

export async function assertReachesTheApp({ url }) {
  const response = await fetch(url, { redirect: "follow" }).catch((error) => ({ error }));
  if (response.error !== undefined) {
    return { ok: false, why: `request failed: ${String(response.error.message ?? response.error).slice(0, 60)}` };
  }

  /*
    The host check does the real work, and body sniffing is the fallback.

    The first version of this guard looked for "Login – Vercel" in the body
    and missed, twice over: the redirect chain ends on vercel.com/*login*
    rather than /sso, and the login page is a 480KB document whose <title>
    sits well past any sane read limit. Meanwhile the thing that is trivially
    and reliably true is that the request left the origin it was aimed at.

    Any off-host landing is worth failing on. Auth walls, parked domains and
    protection interstitials all look like this, and a target that has to
    leave its own origin to answer a homepage request is not a target that can
    be audited, whatever the status code says.
  */
  const wanted = new URL(url).host;
  const landed = new URL(response.url).host;
  if (landed !== wanted) {
    return { ok: false, why: `redirected off-origin to ${landed}`, status: response.status };
  }

  const body = (await response.text().catch(() => "")).slice(0, 8_000);
  const title = ((body.match(/<title[^>]*>([^<]*)/u) ?? [])[1] ?? "").trim();

  if (PLATFORM_ERROR.test(body)) {
    return { ok: false, why: `platform error page (${(body.match(PLATFORM_ERROR) ?? [])[0]})`, status: response.status, title };
  }
  if (/^(404|500|503):/u.test(title)) {
    return { ok: false, why: `platform error page (${title.slice(0, 30)})`, status: response.status, title };
  }
  if (!response.ok) {
    return { ok: false, why: `HTTP ${response.status}`, status: response.status, title };
  }
  return { ok: true, status: response.status, title };
}

export async function auditSite(browser, { name, url }, { maxRoutes = DEFAULT_MAX_ROUTES } = {}) {
  const reached = await assertReachesTheApp({ name, url });
  if (!reached.ok) {
    return {
      name,
      url,
      routes: 0,
      unreachable: reached.why,
      pages: [{ route: "/", findings: [{ severity: "high", what: `target does not serve the app: ${reached.why}` }], measured: {} }]
    };
  }

  const origin = new URL(url).origin;
  const routes = await discoverRoutes(browser, url, { maxRoutes });
  const pages = [];

  for (const route of routes) {
    // Each route gets the full battery: a11y, phone width, broken images,
    // collapsed maps, empty regions, dead links, meta.
    const report = await auditApp(browser, { name: `${name}${route}`, url: `${origin}${route}` });
    pages.push({ route, findings: report.findings, measured: report.measured });
  }

  return { name, url, routes: routes.length, pages };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href
) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const targets = JSON.parse(await readFile(process.argv[2], "utf8"));
  const maxRoutes = Number.parseInt(process.argv[3] ?? "", 10) || DEFAULT_MAX_ROUTES;

  const browser = await chromium.launch({ channel: "chrome" });
  const all = [];

  for (const target of targets) {
    const site = await auditSite(browser, target, { maxRoutes });
    all.push(site);

    const high = site.pages.flatMap((p) => p.findings.filter((f) => f.severity === "high"));
    const med = site.pages.flatMap((p) => p.findings.filter((f) => f.severity === "medium"));
    process.stdout.write(
      `  ${target.name.padEnd(22)} ${String(site.routes).padStart(2)} routes  ` +
        `${String(high.length).padStart(2)} high  ${String(med.length).padStart(2)} med\n`
    );
    for (const page of site.pages) {
      for (const finding of page.findings.filter((f) => f.severity === "high")) {
        process.stdout.write(`      HIGH ${page.route.padEnd(24)} ${finding.what.slice(0, 96)}\n`);
      }
    }
  }

  await browser.close();
  await writeFile("crawl-audit-results.json", `${JSON.stringify(all, null, 2)}\n`);

  const highTotal = all.flatMap((s) => s.pages.flatMap((p) => p.findings.filter((f) => f.severity === "high"))).length;
  process.stdout.write(
    `\n${all.length} apps, ${all.reduce((sum, s) => sum + s.routes, 0)} routes audited, ${highTotal} high findings\n`
  );
}
