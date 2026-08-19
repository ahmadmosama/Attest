#!/usr/bin/env node
/**
 * Derive a binding file and a smoke scenario from a LIVE app, by looking at it.
 *
 * This is GEN-03's crawler, scoped to the job actually in front of it. None of
 * the portfolio apps carry a single `data-testid`, so nothing can be bound by
 * identifier. What they do have is accessible structure: headings, named links,
 * named buttons. Playwright's role engine reads exactly that, and Attest's web
 * bindings already speak `role` + `name`.
 *
 * WHAT THESE SCENARIOS ARE, stated plainly because it changes how much they are
 * worth: they are CHARACTERISATION tests. They assert what the app does today,
 * not what a specification says it should do. That cannot find a wrong feature,
 * and it will catch the app going blank, a route 500ing, a nav link breaking, or
 * a heading disappearing. For 24 apps with no tests at all, that is the
 * difference between noticing a regression in minutes and noticing it never.
 *
 * The crawl is deliberately shallow and read only:
 *
 *   - GET only, never a form submit, never a destructive looking control
 *   - a hard step budget per app
 *   - same origin only, so an outbound link cannot walk the crawler off site
 *
 * Anything it could not ground in an observation is omitted rather than
 * guessed. A scenario that asserts something the generator never saw is worse
 * than no scenario, because it fails for a reason nobody can act on.
 */

import { chromium } from "playwright";

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 2_500;
const MAX_NAV_LINKS = 3;

// Anything that could change state, cost money, or log the crawler out. A read
// only crawl that clicks "Delete" is not read only.
const DESTRUCTIVE = /\b(delete|remove|cancel|sign ?out|log ?out|unsubscribe|pay|buy|checkout|subscribe|upgrade|book|confirm|submit|send|post|publish)\b/i;

function yamlString(value) {
  return JSON.stringify(String(value));
}

function refName(text, fallback) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 34);
  return slug.length > 0 ? slug : fallback;
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * The most specific heading the page actually shows.
 *
 * Used as a screen's `ready` check, so it has to be something that is present
 * when the screen has finished arriving and absent before. A heading is the
 * best available proxy on an app with no test ids.
 */
async function primaryHeading(page) {
  for (const level of [1, 2]) {
    const heading = page.getByRole("heading", { level }).first();
    if ((await heading.count().catch(() => 0)) > 0) {
      const text = (await heading.innerText().catch(() => "")).trim().split("\n")[0];
      if (text.length > 0 && text.length < 90) {
        return { level, text };
      }
    }
  }
  return null;
}

async function namedLinks(page, origin) {
  const links = await page
    .getByRole("link")
    .evaluateAll(
      (nodes) =>
        nodes
          .map((node) => ({
            name: (node.innerText ?? "").trim().split("\n")[0],
            href: node.getAttribute("href") ?? ""
          }))
          .filter((entry) => entry.name.length > 1 && entry.name.length < 40)
    )
    .catch(() => []);

  const seen = new Set();
  return links.filter((link) => {
    if (DESTRUCTIVE.test(link.name) || seen.has(link.name)) {
      return false;
    }
    // Same origin only, and never a bare fragment: an outbound link walks the
    // crawl off the app, and "#" navigates nowhere.
    const internal = link.href.startsWith("/") || link.href.startsWith(origin);
    if (!internal || link.href.startsWith("#")) {
      return false;
    }

    seen.add(link.name);
    return true;
  });
}

export async function probeApp(browser, { name, url }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const origin = new URL(url).origin;

  const observed = { name, url, ok: false, heading: null, landmarks: [], routes: [], reason: null };

  try {
    const response = await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    await settle(page);

    if ((response?.status() ?? 0) >= 400) {
      observed.reason = `home returned HTTP ${response?.status()}`;
      return observed;
    }

    observed.heading = await primaryHeading(page);
    if (observed.heading === null) {
      // Without a ready check there is nothing to converge on, and a scenario
      // that opens a screen it cannot recognise is a timeout waiting to happen.
      observed.reason = "no h1 or h2 to anchor a ready check";
      return observed;
    }

    // Named buttons that are safe to assert the existence of. Not clicked.
    observed.landmarks = (
      await page
        .getByRole("button")
        .evaluateAll((nodes) => nodes.map((node) => (node.innerText ?? "").trim().split("\n")[0]))
        .catch(() => [])
    )
      .filter((text) => text.length > 1 && text.length < 34 && !DESTRUCTIVE.test(text))
      .slice(0, 3);

    // Walk a few internal links and record where they actually land.
    const links = (await namedLinks(page, origin)).slice(0, MAX_NAV_LINKS);
    for (const link of links) {
      try {
        await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
        await settle(page);
        await page.getByRole("link", { name: link.name, exact: true }).first().click({ timeout: 10_000 });
        await settle(page);

        const landed = await primaryHeading(page);
        // The PATH matters as much as the heading: a web screen binding requires
        // one, and recording where the click actually landed makes the scenario
        // assert the route as well as the content.
        const landedPath = new URL(page.url()).pathname || "/";
        if (landed !== null && landed.text !== observed.heading.text && landedPath !== "/") {
          observed.routes.push({ linkName: link.name, heading: landed, path: landedPath });
        }
      } catch {
        // A link that will not navigate is not a crawl failure. It is simply
        // not something this scenario can assert, so it is left out.
      }
    }

    observed.ok = true;
    return observed;
  } catch (error) {
    observed.reason = String(error?.message ?? error).split("\n")[0].slice(0, 90);
    return observed;
  } finally {
    await context.close().catch(() => {});
  }
}

export function renderBindings(observed) {
  const lines = [
    `# ${observed.name}, web. GENERATED from the live app by tools/generate-smoke.mjs.`,
    "#",
    "# Bound by ROLE and NAME rather than by test id, because this app has none.",
    "# That is a weaker binding: renaming a visible label breaks it, where a test",
    "# id would not have. It is what the app supports today, and it is honest",
    "# about that rather than pretending to a stability it does not have.",
    "surface: web",
    "",
    "elements:"
  ];

  lines.push(
    `  text:primary_heading: { role: heading, name: ${yamlString(observed.heading.text)} }`
  );
  for (const [index, label] of observed.landmarks.entries()) {
    lines.push(`  button:${refName(label, `action_${index}`)}: { role: button, name: ${yamlString(label)} }`);
  }
  for (const route of observed.routes) {
    lines.push(`  link:${refName(route.linkName, "nav")}: { role: link, name: ${yamlString(route.linkName)} }`);
  }

  lines.push("", "screens:");
  lines.push(
    `  screen:home: { path: "/", ready: { role: heading, name: ${yamlString(observed.heading.text)} } }`
  );
  for (const route of observed.routes) {
    lines.push(
      `  screen:${refName(route.linkName, "nav")}: ` +
        `{ path: ${yamlString(route.path)}, ready: { role: heading, name: ${yamlString(route.heading.text)} } }`
    );
  }

  lines.push("", "states: {}", "");
  return lines.join("\n");
}

export function renderScenario(observed) {
  const lines = [
    `id: ${observed.name.replace(/[^a-z0-9]+/giu, "_").toLowerCase()}.smoke`,
    "requirement: [SMOKE-01]",
    "tags: [portfolio, smoke, generated]",
    "",
    "# GENERATED from the live app. A CHARACTERISATION test: it asserts what the",
    "# app did when it was observed, not what a specification says it should do.",
    "# It cannot find a wrong feature. It will catch the page going blank, a route",
    "# breaking, a nav link dying or the heading disappearing, which for an app",
    "# with no tests at all is the whole of the difference between noticing a",
    "# regression and never noticing it.",
    "steps:",
    "  - open: screen:home",
    "  - expect_visible: screen:home",
    "  - expect_visible: text:primary_heading",
    "  - checkpoint: home"
  ];

  for (const label of observed.landmarks) {
    lines.push(`  - expect_visible: button:${refName(label, "action")}`);
  }

  for (const route of observed.routes) {
    const ref = refName(route.linkName, "nav");
    // Back to home before each one, because that is how it was OBSERVED: the
    // crawler returned home before probing every link. Chaining them instead
    // would assert that the second link exists on the first link's destination,
    // which was never checked and is usually false. A generated scenario has to
    // assert what was seen, not what would read more naturally.
    lines.push(
      "",
      "  - open: screen:home",
      `  - tap: link:${ref}`,
      `  - expect_visible: screen:${ref}`,
      `  - checkpoint: ${ref}`
    );
  }

  lines.push("");
  return lines.join("\n");
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const path = await import("node:path");

  const targetsFile = process.argv[2];
  const outRoot = process.argv[3] ?? "examples/portfolio";
  if (targetsFile === undefined) {
    process.stderr.write("usage: generate-smoke.mjs <targets.json> [outDir]\n");
    process.exit(2);
  }

  const targets = JSON.parse(await readFile(targetsFile, "utf8"));
  const browser = await chromium.launch({ channel: "chrome" });
  const generated = [];
  const skipped = [];

  for (const target of targets) {
    const observed = await probeApp(browser, target);
    if (!observed.ok) {
      skipped.push({ name: target.name, reason: observed.reason });
      process.stdout.write(`  skip ${target.name.padEnd(24)} ${observed.reason}\n`);
      continue;
    }

    // One bindings ROOT per app: the loader requires a bindings directory to
    // identify exactly one app, so 22 app folders under a single root is
    // refused with E_BINDINGS_APP_REQUIRED. Each app gets its own tree.
    const appRoot = path.join(outRoot, target.name);
    const bindingsDir = path.join(appRoot, "bindings", target.name);
    await mkdir(bindingsDir, { recursive: true });
    await mkdir(path.join(appRoot, "scenarios"), { recursive: true });
    await writeFile(path.join(bindingsDir, "web.yaml"), renderBindings(observed));
    await writeFile(
      path.join(appRoot, "scenarios", `${target.name}.attest.yaml`),
      renderScenario(observed)
    );

    generated.push({ name: target.name, routes: observed.routes.length, landmarks: observed.landmarks.length });
    process.stdout.write(
      `  gen  ${target.name.padEnd(24)} heading + ${observed.landmarks.length} button(s) + ${observed.routes.length} route(s)\n`
    );
  }

  await browser.close();
  process.stdout.write(`\ngenerated ${generated.length}, skipped ${skipped.length}\n`);
  await writeFile(
    path.join(outRoot, "GENERATED.json"),
    `${JSON.stringify({ generated, skipped }, null, 2)}\n`
  );
}
