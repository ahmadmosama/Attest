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
 * Images the browser could not paint.
 *
 * `naturalWidth === 0` on a complete image means it failed, whatever the
 * network tab says. Nest was serving two listing cards with a dead Unsplash id
 * that answers 404 with an HTML error page: Chrome blocks that as a cross
 * origin non-image (ERR_BLOCKED_BY_ORB), so there was no console error and no
 * failed HTTP status to notice, just a broken card.
 */
async function brokenImages(page) {
  return page.evaluate(() =>
    Array.from(document.images)
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => ({ src: (img.currentSrc || img.src).slice(0, 110), alt: (img.alt || "").slice(0, 50) }))
      .slice(0, 5)
  );
}

/**
 * A map container that collapsed to nothing.
 *
 * Map libraries measure their container once at construction. If CSS from the
 * library itself overrides the positioning the container relied on, it can end
 * up with zero height, and the library then falls back to a default canvas size
 * inside a panel that shows nothing. Nest lost the entire right half of
 * /search this way while tiles downloaded and markers built without error.
 */
async function collapsedMapContainers(page) {
  return page.evaluate(() => {
    // A map ROOT with (near) zero height inside a parent that has real height.
    //
    // This replaced a ratio test ("canvas fills less than 75% of its
    // container"), which could not tell a COLLAPSED map from a deliberately
    // short one. backtrack sizes its map `h-[320px]` on purpose and was
    // reported as broken; Nest's had genuinely collapsed to 0. A height of zero
    // is unambiguous, so it is the thing to test, and the ratio was noise.
    return Array.from(document.querySelectorAll(".maplibregl-map, .leaflet-container"))
      .map((root) => {
        const rect = root.getBoundingClientRect();
        const parentRect = root.parentElement?.getBoundingClientRect();
        if (!parentRect || rect.height > 50 || parentRect.height < 200) {
          return null;
        }
        return {
          root: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          parent: `${Math.round(parentRect.width)}x${Math.round(parentRect.height)}`,
          cls: String(root.className).slice(0, 50)
        };
      })
      .filter(Boolean)
      .slice(0, 2);
  });
}

/**
 * A large visible region with nothing painted in it.
 *
 * The generic version of the map bug: whatever the cause, a 900x700 panel that
 * contains no text, no image and no canvas is a hole in the page.
 */
async function emptyRegions(page) {
  return page.evaluate(() =>
    Array.from(document.body.querySelectorAll("div"))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 400 || rect.height < 300 || rect.top > window.innerHeight) {
          return false;
        }
        // Only leaf-ish containers: a wrapper is "empty" of its own text while
        // its children carry the page, and flagging it would be noise.
        if (el.children.length > 1) {
          return false;
        }

        // DECORATION IS NOT A HOLE. Gradient washes, grain textures and ambient
        // background layers are supposed to contain no text and no image: that
        // is what they are. The first version of this check flagged six of
        // them (`ambient-bg`, `scene-grain`, `absolute inset-0 -z-10 bg-gradient`)
        // as high severity, which is how a report becomes something nobody
        // reads. Each was verified by hand as decorative before this filter was
        // written.
        const style = getComputedStyle(el);
        const isDecoration =
          el.getAttribute("aria-hidden") === "true" ||
          style.pointerEvents === "none" ||
          Number.parseInt(style.zIndex, 10) < 0 ||
          style.backgroundImage !== "none";
        if (isDecoration) {
          return false;
        }

        const hasText = (el.innerText ?? "").trim().length > 0;
        const hasPaint = el.querySelector("img, canvas, svg, video, iframe") !== null;

        // A descendant painting a background counts as paint. khayat has an
        // aspect-ratio panel whose CHILD carries a repeating-linear-gradient
        // texture: the parent's own background is "none", so checking only the
        // element itself called a deliberately styled swatch an empty hole.
        const childPaints = Array.from(el.querySelectorAll("*")).some(
          (child) => getComputedStyle(child).backgroundImage !== "none"
        );

        return !hasText && !hasPaint && !childPaints;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return `${Math.round(rect.width)}x${Math.round(rect.height)} <${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 34)}">`;
      })
      .slice(0, 3)
  );
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
    report.measured.brokenImages = await brokenImages(page);
    report.measured.collapsedMaps = await collapsedMapContainers(page);
    report.measured.emptyRegions = await emptyRegions(page);
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

  const {
    a11y = {},
    seo = {},
    links = {},
    mobile = {},
    brokenImages: images = [],
    collapsedMaps: canvases = [],
    emptyRegions: holes = []
  } = report.measured;

  if (images.length > 0) {
    report.findings.push({
      severity: "high",
      what: `${images.length} image(s) fail to load: ${images[0].alt || images[0].src}`
    });
  }
  if (canvases.length > 0) {
    report.findings.push({
      severity: "high",
      what: `map container collapsed to ${canvases[0].root} inside a ${canvases[0].parent} parent, so the map renders nothing`
    });
  }
  if (holes.length > 0) {
    report.findings.push({ severity: "high", what: `empty region on screen: ${holes[0]}` });
  }
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
