import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_FORBIDDEN_PATTERNS,
  scanBundleForSecrets
} from "../../src/evidence/scan.mjs";
import { writeZip } from "../../src/evidence/zip.mjs";

async function withRepoTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(process.cwd(), `test/evidence/${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeNested(root, relPath, data) {
  const target = path.join(root, ...relPath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  return target;
}

test("DEFAULT_FORBIDDEN_PATTERNS covers sensitive names case insensitively", () => {
  assert.equal(Object.isFrozen(DEFAULT_FORBIDDEN_PATTERNS), true);

  for (const value of ["authorization", "COOKIE", "Set-Cookie", "ApiKey"]) {
    assert(DEFAULT_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value)));
  }
});

test("plain text findings include relative path, line number, and masked preview", async () => {
  await withRepoTemp("scan-text", async (root) => {
    await writeNested(root, "logs/network.txt", "first\nAuthorization: Bearer abcdefghijklmnop\n");

    const findings = await scanBundleForSecrets(root, { patterns: [/Authorization/i] });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, "logs/network.txt");
    assert.equal(findings[0].line, 2);
    assert.equal(findings[0].preview.includes("Authorization"), false);
    assert.equal(findings[0].preview.includes("[MATCH]"), true);
  });
});

test("zip findings include archive path and inflated entry name", async () => {
  await withRepoTemp("scan-zip", async (root) => {
    const token = "Bearer abcdefghijklmnopqrstu";
    const zip = writeZip([{ name: "trace/0.network", data: Buffer.from(`header: ${token}\n`) }]);
    await writeNested(root, "evidence/trace.zip", zip);

    const findings = await scanBundleForSecrets(root, {
      patterns: [],
      literals: [token]
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, "evidence/trace.zip");
    assert.equal(findings[0].entry, "trace/0.network");
    assert.equal(findings[0].line, 1);
    assert.equal(findings[0].pattern, "literal");
    assert.equal(findings[0].preview.includes(token), false);
  });
});

test("binary files are scanned as bytes for literal secrets", async () => {
  await withRepoTemp("scan-binary", async (root) => {
    const token = "binary-secret-123456";
    await writeNested(root, "evidence/screenshot.png", Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from(token)
    ]));

    const findings = await scanBundleForSecrets(root, {
      patterns: [],
      literals: [token]
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, "evidence/screenshot.png");
    assert.equal(findings[0].line, null);
  });
});

test("clean bundles return an empty findings array", async () => {
  await withRepoTemp("scan-clean", async (root) => {
    await writeNested(root, "evidence/network.jsonl", "{\"headers\":{\"accept\":\"text/html\"}}\n");
    await writeNested(root, "evidence/trace.zip", writeZip([{ name: "trace.trace", data: "clean\n" }]));

    assert.deepEqual(await scanBundleForSecrets(root), []);
  });
});

test("oversized files surface as UNSCANNED findings", async () => {
  await withRepoTemp("scan-large", async (root) => {
    await writeNested(root, "large.txt", "abcdef");

    const findings = await scanBundleForSecrets(root, { maxFileBytes: 3 });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, "large.txt");
    assert.equal(findings[0].pattern, "UNSCANNED");
  });
});

test("zip entries over the configured ceiling surface as UNSCANNED", async () => {
  await withRepoTemp("scan-zip-large", async (root) => {
    await writeNested(root, "trace.zip", writeZip([{ name: "large.trace", data: "abcdef" }]));

    const findings = await scanBundleForSecrets(root, { maxFileBytes: 3, patterns: [/abc/] });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, "trace.zip");
    assert.equal(findings[0].pattern, "UNSCANNED");
  });
});
