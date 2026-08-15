import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { UsageError } from "../../src/errors.mjs";
import { classifyAppArtifact, APP_ARTIFACT_KINDS } from "../../src/config/app-artifact.mjs";

function localHeader(name) {
  const bytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(bytes.length, 26);
  return Buffer.concat([header, bytes]);
}

function centralHeader(name, localOffset) {
  const bytes = Buffer.from(name);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(bytes.length, 28);
  header.writeUInt32LE(localOffset, 42);
  return Buffer.concat([header, bytes]);
}

function endRecord(centralSize, centralOffset, count) {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(count, 8);
  header.writeUInt16LE(count, 10);
  header.writeUInt32LE(centralSize, 12);
  header.writeUInt32LE(centralOffset, 16);
  return header;
}

function zipWithEntries(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const local = localHeader(entry);
    locals.push(local);
    centrals.push(centralHeader(entry, offset));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, endRecord(central.length, offset, entries.length)]);
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(process.cwd(), "test/config/app-artifact-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("classifyAppArtifact accepts the documented artifact kinds", async () => {
  assert.deepEqual(APP_ARTIFACT_KINDS, ["web_url", "android_apk", "ios_app_bundle"]);
  assert.deepEqual(classifyAppArtifact("https://candor-two-theta.vercel.app"), {
    kind: "web_url",
    url: "https://candor-two-theta.vercel.app",
    surface: "web"
  });
  assert.deepEqual(classifyAppArtifact("build/app-release.apk"), {
    kind: "android_apk",
    path: "build/app-release.apk",
    surface: "android"
  });
  assert.deepEqual(classifyAppArtifact("build/Runner.app"), {
    kind: "ios_app_bundle",
    path: "build/Runner.app",
    surface: "ios"
  });
});

test("classifyAppArtifact accepts zipped iOS simulator app bundles", async () => {
  await withTempDir(async (dir) => {
    const named = path.join(dir, "Runner.app.zip");
    const plain = path.join(dir, "artifact.zip");
    await writeFile(named, zipWithEntries(["Runner.app/", "Runner.app/Info.plist"]));
    await writeFile(plain, zipWithEntries(["Runner.app/Info.plist"]));

    assert.deepEqual(classifyAppArtifact(named), {
      kind: "ios_app_bundle",
      path: named,
      surface: "ios"
    });
    assert.deepEqual(classifyAppArtifact(plain), {
      kind: "ios_app_bundle",
      path: plain,
      surface: "ios"
    });
  });
});

test("classifyAppArtifact refuses a device ipa with actionable simulator wording", () => {
  assert.throws(
    () => classifyAppArtifact("build/Runner.ipa"),
    (error) => {
      assert(error instanceof UsageError);
      assert.equal(error.code, "E_IOS_DEVICE_ARTIFACT");
      assert.match(error.message, /The iOS Simulator cannot install a device \.ipa/);
      assert.match(error.message, /generic\/platform=iOS Simulator/);
      assert.match(error.message, /pass the resulting \.app bundle/);
      return true;
    }
  );
});

test("classifyAppArtifact refuses unknown artifacts and zip files without an app bundle", async () => {
  assert.throws(
    () => classifyAppArtifact("build/thing.aab"),
    (error) => {
      assert.equal(error.code, "E_UNKNOWN_APP_ARTIFACT");
      assert.match(error.message, /web URL, Android \.apk, iOS Simulator \.app/);
      return true;
    }
  );

  await withTempDir(async (dir) => {
    const zip = path.join(dir, "plain.zip");
    await writeFile(zip, zipWithEntries(["Payload/Runner.txt"]));

    assert.throws(() => classifyAppArtifact(zip), /E_UNKNOWN_APP_ARTIFACT|Unknown app artifact/);
  });
});
