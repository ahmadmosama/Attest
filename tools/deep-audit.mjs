#!/usr/bin/env node
/**
 * A deeper Playwright pass, for the things a scenario does not look at.
 *
 * Attest answers "does this app do what the scenario says". This answers a
 * different question: "is this app WELL BUILT", which no scenario asserts
 * because no scenario knows to. The two find different bugs and neither
 * replaces the other.
 *
 * The Attest smoke pass on the same 24 apps found one blank page. This pass is
 * where the quieter problems live: a viewport that overflows on a phone, an
 * image with no alt text, a form field with no label, a link to nowhere.
 *
 * Everything here is READ ONLY. It navigates and inspects; it never submits a
 * form or clicks a destructive control.
 *
 * Each check reports what it MEASURED, not a grade. "3 images without alt" is
 * actionable; "accessibility score 82" is not.
 */

import { chromium, devices } from "playwright";

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 2_500;
const PHONE = devices["iPhone 13"];

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Content wider than the viewport on a phone.
 *
 * The single most common real defect on a personal-project landing page, and
 * invisible on a desktop browser, which is where these get built and looked at.
 */
async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const docWidth = document.documentElement.clientWidth;
    const offenders = [];

    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect();
      // 2px of tolerance: sub-pixel rounding is not a bug.
      if (rect.width > 0 && rect.right > docWidth + 2) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className ?? "").slice(0, 40),
          overflowPx: Math.round(rect.right - docWidth)
        });
      }
    }

    return {
      scrolls: document.documentElement.scrollWidth > docWidth + 2,
      overflowPx: Math.max(0, document.documentElement.scrollWidth - docWidth),
      // The widest few. A single overflowing container usually explains all of
      // its children, so the list is capped rather than exhaustive.
      worst: offenders.toSorted((a, b) => b.overflowPx - a.overflowPx).slice(0, 3)
    };
  });
}

/**
 * The accessibility checks that are unambiguous.
 *
 * Deliberately not a full audit: these are the ones where the finding is a fact
 * rather than a judgement, so a report of "2" means two things to go and fix.
 */
async function accessibility(page) {
  return page.evaluate(() => {
    const imagesNoAlt = Array.from(document.querySelectorAll("img")).filter(
      (img) => !img.hasAttribute("alt") && img.getAttribute("role") !== "presentation"
    ).length;

    const inputsNoLabel = Array.from(
      document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea")
    ).filter((el) => {
      if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title")) {
        return false;
      }
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) {
        return false;
      }
      return el.closest("label") === null;
    }).length;

    const buttonsNoName = Array.from(document.querySelectorAll("button, [role=button]")).filter(
      (el) => (el.innerText ?? "").trim() === "" && !el.getAttribute("aria-label") && !el.getAttribute("title")
    ).length;

    // A page with no h1 is hard to navigate with a screen reader and usually
    // means the heading hierarchy was never thought about.
    const h1Count = document.querySelectorAll("h1").length;
    const langSet = Boolean(document.documentElement.getAttribute("lang"));
    const titleSet = (document.title ?? "").trim().length > 0;

    return { imagesNoAlt, inputsNoLabel, buttonsNoName, h1Count, langSet, titleSet };
  });
}

async function metaAndSeo(page) {
  return page.evaluate(() => {
    const meta = (name) =>
      document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ??
      document.querySelector(`meta[property="og:${name}"]`)?.getAttribute("content") ??
      null;

    return {
      description: Boolean(meta("description")),
      ogTitle: Boolean(document.querySelector('meta[property="og:title"]')),
      ogImage: Boolean(document.querySelector('meta[property="og:image"]')),
      viewport: Boolean(document.querySelector('meta[name="viewport"]')),
      favicon: Boolean(document.querySelector('link[rel~="icon"]'))
    };
  });
}

/**
 * Internal links that do not resolve.
 *
 * HEAD first, because a GET on every link of every app is a lot of traffic to
 * somebody else's server; falls back to GET where HEAD is not allowed, which
 * some hosts do.
 */
async function brokenLinks(page, origin, { limit = 12 } = {}) {
  const hrefs = await page
    .getByRole("link")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href") ?? ""))
    .catch(() => []);

  const internal = [
    ...new Set(
      hrefs
        .filter((href) => href.startsWith("/") && !href.startsWith("//"))
        .map((href) => href.split("#")[0])
        .filter((href) => href.length > 1)
    )
  ].slice(0, limit);

  const broken = [];
  for (const href of internal) {
    const url = `${origin}${href}`;
    try {
      let response = await page.request.head(url, { timeout: 15_000, failOnStatusCode: false });
      if (response.status() === 405 || response.status() === 501) {
        response = await page.request.get(url, { timeout: 15_000, failOnStatusCode: false });
      }
      if (response.status() >= 400) {
        broken.push(`${href} -> ${response.status()}`);
      }
    } catch {
      broken.push(`${href} -> unreachable`);
    }
  }

  return { checked: internal.length, broken };
}

export async function auditApp(browser, { name, url }) {
  const origin = new URL(url).origin;
  const report = { name, url, findings: [], measured: {} };

  // Desktop pass.
  const desktop = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await desktop.newPage();
  try {
    await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    await settle(page);

    report.measured.a11y = await accessibility(page);
    report.measured.seo = await metaAndSeo(page);
    report.measured.links = await brokenLinks(page, origin);
  } catch (error) {
    report.findings.push({ severity: "high", what: `desktop load failed: ${String(error?.message ?? error).slice(0, 80)}` });
  } finally {
    await desktop.close().catch(() => {});
  }

  // Phone pass, which is where layout defects actually show up.
  const phone = await browser.newContext({ ...PHONE, ignoreHTTPSErrors: true });
  const mobilePage = await phone.newPage();
  try {
    await mobilePage.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    await settle(mobilePage);
    report.measured.mobile = await horizontalOverflow(mobilePage);
  } catch (error) {
    report.findings.push({ severity: "high", what: `mobile load failed: ${String(error?.message ?? error).slice(0, 80)}` });
  } finally {
    await phone.close().catch(() => {});
  }

  const { a11y = {}, seo = {}, links = {}, mobile = {} } = report.measured;

  if (mobile.scrolls) {
    report.findings.push({
      severity: "high",
      what: `scrolls sideways on a phone by ${mobile.overflowPx}px` +
        (mobile.worst?.[0] ? ` (widest: <${mobile.worst[0].tag} class="${mobile.worst[0].cls}">)` : "")
    });
  }
  if ((links.broken ?? []).length > 0) {
    report.findings.push({ severity: "high", what: `${links.broken.length} broken internal link(s): ${links.broken.slice(0, 3).join(", ")}` });
  }
  if (a11y.h1Count === 0) {
    report.findings.push({ severity: "medium", what: "no <h1> on the page" });
  }
  if (a11y.h1Count > 1) {
    report.findings.push({ severity: "low", what: `${a11y.h1Count} <h1> elements, should be one` });
  }
  if (a11y.imagesNoAlt > 0) {
    report.findings.push({ severity: "medium", what: `${a11y.imagesNoAlt} image(s) with no alt text` });
  }
  if (a11y.inputsNoLabel > 0) {
    report.findings.push({ severity: "medium", what: `${a11y.inputsNoLabel} form field(s) with no label` });
  }
  if (a11y.buttonsNoName > 0) {
    report.findings.push({ severity: "medium", what: `${a11y.buttonsNoName} button(s) with no accessible name` });
  }
  if (a11y.langSet === false) {
    report.findings.push({ severity: "low", what: "<html> has no lang attribute" });
  }
  if (seo.viewport === false) {
    report.findings.push({ severity: "high", what: "no viewport meta tag, the page will not adapt on a phone" });
  }
  if (seo.description === false) {
    report.findings.push({ severity: "low", what: "no meta description" });
  }
  if (seo.ogImage === false) {
    report.findings.push({ severity: "low", what: "no og:image, link previews will be blank" });
  }

  return report;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const targets = JSON.parse(await readFile(process.argv[2], "utf8"));
  const browser = await chromium.launch({ channel: "chrome" });
  const reports = [];

  for (const target of targets) {
    const report = await auditApp(browser, target);
    reports.push(report);
    const high = report.findings.filter((f) => f.severity === "high").length;
    const med = report.findings.filter((f) => f.severity === "medium").length;
    const low = report.findings.filter((f) => f.severity === "low").length;
    process.stdout.write(
      `  ${target.name.padEnd(24)} ${String(high).padStart(2)} high  ${String(med).padStart(2)} med  ${String(low).padStart(2)} low` +
        `${high > 0 ? "   " + report.findings.find((f) => f.severity === "high").what.slice(0, 74) : ""}\n`
    );
  }

  await browser.close();
  await writeFile("deep-audit-results.json", `${JSON.stringify(reports, null, 2)}\n`);

  const all = reports.flatMap((r) => r.findings);
  process.stdout.write(
    `\n${reports.length} apps audited: ` +
      `${all.filter((f) => f.severity === "high").length} high, ` +
      `${all.filter((f) => f.severity === "medium").length} medium, ` +
      `${all.filter((f) => f.severity === "low").length} low\n`
  );
  process.stdout.write("wrote deep-audit-results.json\n");
}
