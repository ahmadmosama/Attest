#!/usr/bin/env node
/**
 * Pick the iOS simulator runtime the suite will run on.
 *
 * This exists because of what the first real macOS run reported on 2026-08-18.
 * The workflow pinned Xcode and the runtime to an exact `26.1`. On the real
 * macos-26 image Xcode 26.1.1 is installed and pins fine, but the iOS 26.1
 * *runtime* is not on the image at all: it ships 26.2, 26.4 and 26.5. That is
 * runner image issue 13853's pattern inverted, and the pre-suite assertion
 * caught it exactly as designed.
 *
 * The lesson is about the SHAPE of the pin, not the number. An exact pin breaks
 * on every image rotation, and that treadmill ends one way: somebody deletes the
 * pin and goes back to trusting the default. What is actually worth preventing
 * is *silent* drift. So this takes the newest runtime at or above a floor and
 * reports which one it chose, loudly. A green job still means something, because
 * you can always read what it ran on.
 *
 * It is a script rather than inline shell so it can be tested on Windows, where
 * there is no simctl. `simctl list runtimes --json` output goes in, an
 * identifier comes out, and the parsing is asserted against committed fixtures.
 */

const USAGE = "usage: select-ios-runtime.mjs --min <version> [--json <file>]";

export class RuntimeSelectionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RuntimeSelectionError";
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Compare two dotted version strings numerically.
 *
 * Not lexicographic: "26.10" is above "26.9", and a string sort puts it below.
 * Missing components read as zero so "26" and "26.0" compare equal.
 */
export function compareVersions(left, right) {
  const a = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

/**
 * Choose the newest available iOS runtime at or above `minVersion`.
 *
 * Returns the runtime's `identifier`, never a string rebuilt from its version.
 * The display name carries a patch the identifier does not
 * ("iOS 26.4 (26.4.1 - 23E254a)" is `com.apple.CoreSimulator.SimRuntime.iOS-26-4`),
 * and reconstructing the id from the name is how `simctl create` fails with an
 * unhelpful "invalid runtime".
 */
export function selectRuntime(listing, { minVersion, platform = "iOS" } = {}) {
  if (typeof minVersion !== "string" || minVersion.length === 0) {
    throw new RuntimeSelectionError("A minimum version is required", { minVersion });
  }

  const parsed = typeof listing === "string" ? JSON.parse(listing) : listing;
  const runtimes = Array.isArray(parsed?.runtimes) ? parsed.runtimes : null;

  if (runtimes === null) {
    throw new RuntimeSelectionError("simctl output did not contain a runtimes array", {
      received: typeof parsed
    });
  }

  // `isAvailable: false` runtimes appear in the listing and cannot be booted.
  // Treating one as usable produces a confusing boot failure much later.
  const usable = runtimes.filter(
    (runtime) =>
      runtime?.isAvailable === true &&
      (runtime.platform === platform || String(runtime.identifier ?? "").includes(`SimRuntime.${platform}-`)) &&
      typeof runtime.version === "string" &&
      typeof runtime.identifier === "string"
  );

  const eligible = usable.filter((runtime) => compareVersions(runtime.version, minVersion) >= 0);

  if (eligible.length === 0) {
    throw new RuntimeSelectionError(
      `No available ${platform} runtime at or above ${minVersion}`,
      {
        minVersion,
        // The available list, by name, so the error says what to change the
        // floor to rather than only what is wrong.
        available: usable.map((runtime) => `${runtime.name ?? runtime.version} (${runtime.identifier})`)
      }
    );
  }

  const chosen = eligible.toSorted((left, right) => compareVersions(right.version, left.version))[0];

  return Object.freeze({
    identifier: chosen.identifier,
    version: chosen.version,
    name: chosen.name ?? `${platform} ${chosen.version}`
  });
}

function parseArgs(argv) {
  const args = { min: null, json: null };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--min") {
      args.min = argv[index + 1] ?? null;
      index += 1;
    } else if (argv[index] === "--json") {
      args.json = argv[index + 1] ?? null;
      index += 1;
    }
  }

  return args;
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.min === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const listing =
    args.json === null
      ? await readAllStdin()
      : await (await import("node:fs/promises")).readFile(args.json, "utf8");

  try {
    const runtime = selectRuntime(listing, { minVersion: args.min });
    process.stdout.write(`${runtime.identifier}\n`);
    return 0;
  } catch (error) {
    if (error instanceof RuntimeSelectionError) {
      process.stderr.write(`${error.message}\n`);
      for (const name of error.details.available ?? []) {
        process.stderr.write(`  available: ${name}\n`);
      }
      return 1;
    }
    throw error;
  }
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
