#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Build the Android self verification fixture APK, offline.
 *
 * Gradle was the first choice and was rejected once the SDK was inspected.
 * Gradle has to resolve the Android Gradle Plugin from Google Maven on a cold
 * build, which would put a network dependency in the critical path of a
 * fixture whose whole job is to be deterministic. aapt2, d8, zipalign and
 * apksigner are already installed under build-tools, android.jar is under
 * platforms, and the Android Studio JBR ships javac. That is a complete
 * offline toolchain and about a hundred lines of script.
 *
 *   node tools/build-fixture-apk.mjs [--out <apk>] [--sdk <dir>] [--jdk <dir>]
 */

const SOURCE_DIR = path.join("fixtures", "self-verify", "android");
const DEFAULT_OUT = path.join(".attest", "fixture", "attest-selfverify.apk");
const PACKAGE_NAME = "attest.selfverify";
const MIN_SDK = "24";
const TARGET_SDK = "35";
const KEYSTORE_PASSWORD = "android";
const KEY_ALIAS = "androiddebugkey";

export class BuildError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BuildError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function parseArgs(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) {
      flags.set(argv[index].slice(2), argv[index + 1]);
      index += 1;
    }
  }
  return flags;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0 && existsSync(candidate)) ?? null;
}

export function resolveSdk(env = process.env) {
  const root = firstExisting([
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    env.LOCALAPPDATA === undefined ? null : path.join(env.LOCALAPPDATA, "Android", "Sdk"),
    env.HOME === undefined ? null : path.join(env.HOME, "Android", "Sdk")
  ]);

  if (root === null) {
    throw new BuildError("E_SDK_NOT_FOUND", "Could not locate the Android SDK", {
      remediation: "Set ANDROID_HOME or ANDROID_SDK_ROOT to the SDK directory."
    });
  }

  return root;
}

async function newestDirectory(parent) {
  const entries = await readdir(parent, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  return versions.length > 0 ? versions[0] : null;
}

// java is deliberately NOT taken from PATH: ENV-VERIFIED records that it is not
// on PATH on this machine, and the Android Studio JBR is what is installed.
export const DEFAULT_JDK_CANDIDATES = Object.freeze([
  "C:\\Program Files\\Android\\Android Studio\\jbr",
  "/usr/lib/jvm/default-java"
]);

export async function resolveToolchain({
  sdk,
  jdk,
  env = process.env,
  jdkCandidates = DEFAULT_JDK_CANDIDATES
} = {}) {
  const sdkRoot = sdk ?? resolveSdk(env);
  const exe = process.platform === "win32" ? ".exe" : "";

  const buildToolsRoot = path.join(sdkRoot, "build-tools");
  if (!existsSync(buildToolsRoot)) {
    throw new BuildError("E_BUILD_TOOLS_NOT_FOUND", "The SDK has no build-tools installed", {
      searched: buildToolsRoot,
      remediation: "Install build-tools through Android Studio's SDK Manager."
    });
  }

  const buildToolsVersion = await newestDirectory(buildToolsRoot);
  const buildTools = path.join(buildToolsRoot, buildToolsVersion);

  const platformsRoot = path.join(sdkRoot, "platforms");
  const platformVersion = await newestDirectory(platformsRoot);
  const androidJar = platformVersion === null ? null : path.join(platformsRoot, platformVersion, "android.jar");
  if (androidJar === null || !existsSync(androidJar)) {
    throw new BuildError("E_PLATFORM_NOT_FOUND", "The SDK has no android.jar platform installed", {
      searched: platformsRoot,
      remediation: "Install an Android platform through Android Studio's SDK Manager."
    });
  }

  const jdkHome = firstExisting([jdk, env.ATTEST_JDK_HOME, env.JAVA_HOME, ...jdkCandidates]);

  if (jdkHome === null) {
    throw new BuildError("E_JDK_NOT_FOUND", "Could not locate a JDK", {
      remediation: "Set JAVA_HOME or ATTEST_JDK_HOME to a JDK 17 or newer, for example the Android Studio JBR."
    });
  }

  return Object.freeze({
    sdkRoot,
    buildTools,
    buildToolsVersion,
    androidJar,
    platformVersion,
    jdkHome,
    aapt2: path.join(buildTools, `aapt2${exe}`),
    aapt: path.join(buildTools, `aapt${exe}`),
    zipalign: path.join(buildTools, `zipalign${exe}`),
    javac: path.join(jdkHome, "bin", `javac${exe}`),
    keytool: path.join(jdkHome, "bin", `keytool${exe}`),
    java: path.join(jdkHome, "bin", `java${exe}`),
    // d8 and apksigner ship as .bat wrappers around a jar, and Node refuses to
    // spawn a .bat without a shell. Calling the jar the wrapper calls keeps
    // shell:false, which is the rule everywhere else in this project too.
    d8Jar: path.join(buildTools, "lib", "d8.jar"),
    apksignerJar: path.join(buildTools, "lib", "apksigner.jar")
  });
}

function runTool(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    // shell false, argv array, same rule the adb layer follows: nothing on this
    // machine's paths should be able to reach a shell.
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) =>
      reject(
        new BuildError("E_TOOL_SPAWN_FAILED", `Could not start ${path.basename(command)}`, {
          command,
          reason: error.message
        })
      )
    );
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");

      if (code !== 0) {
        reject(
          new BuildError("E_TOOL_FAILED", `${path.basename(command)} exited with ${code}`, {
            command,
            args,
            stdout: stdout.slice(-4000),
            stderr: stderr.slice(-4000)
          })
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function javaFilesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

async function ensureKeystore(tools, keystore) {
  if (existsSync(keystore)) {
    return keystore;
  }

  await runTool(tools.keytool, [
    "-genkeypair",
    "-keystore", keystore,
    "-storepass", KEYSTORE_PASSWORD,
    "-keypass", KEYSTORE_PASSWORD,
    "-alias", KEY_ALIAS,
    "-keyalg", "RSA",
    "-keysize", "2048",
    "-validity", "10000",
    "-dname", "CN=Attest Fixture, O=Attest, C=US"
  ]);

  return keystore;
}

async function sha256Of(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function buildFixtureApk({
  out = DEFAULT_OUT,
  sourceDir = SOURCE_DIR,
  sdk = null,
  jdk = null,
  env = process.env,
  cwd = process.cwd()
} = {}) {
  const tools = await resolveToolchain({ sdk, jdk, env });
  const source = path.resolve(cwd, sourceDir);
  const outPath = path.resolve(cwd, out);
  const work = path.join(path.dirname(outPath), "build");

  if (!existsSync(path.join(source, "AndroidManifest.xml"))) {
    throw new BuildError("E_FIXTURE_SOURCE_MISSING", "The android fixture source is missing", {
      searched: source
    });
  }

  await rm(work, { recursive: true, force: true });
  await mkdir(path.join(work, "classes"), { recursive: true });
  await mkdir(path.join(work, "gen"), { recursive: true });
  await mkdir(path.join(work, "dex"), { recursive: true });

  // 1. Resources: compile then link. Linking also emits R.java, which is what
  //    gives every view a real resource-id in the uiautomator dump.
  const compiledRes = path.join(work, "res.zip");
  await runTool(tools.aapt2, ["compile", "--dir", path.join(source, "res"), "-o", compiledRes]);

  const baseApk = path.join(work, "base.apk");
  await runTool(tools.aapt2, [
    "link",
    "-o", baseApk,
    "-I", tools.androidJar,
    "--manifest", path.join(source, "AndroidManifest.xml"),
    "--java", path.join(work, "gen"),
    "--min-sdk-version", MIN_SDK,
    "--target-sdk-version", TARGET_SDK,
    compiledRes
  ]);

  // 2. Java: the activity plus the generated R.
  const sources = [...(await javaFilesIn(path.join(source, "java"))), ...(await javaFilesIn(path.join(work, "gen")))];
  await runTool(tools.javac, [
    "-nowarn",
    "-source", "17",
    "-target", "17",
    "-encoding", "UTF-8",
    "-classpath", tools.androidJar,
    "-d", path.join(work, "classes"),
    ...sources
  ]);

  // 3. Dex.
  const classFiles = (await readdir(path.join(work, "classes"), { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".class"))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));

  await runTool(tools.java, [
    "-cp", tools.d8Jar,
    "com.android.tools.r8.D8",
    "--lib", tools.androidJar,
    "--min-api", MIN_SDK,
    "--output", path.join(work, "dex"),
    ...classFiles
  ]);

  // 4. Put classes.dex in the APK. `aapt add` stores the entry under the path
  //    it is given, so it runs from the dex directory to avoid a nested path.
  await runTool(tools.aapt, ["add", path.resolve(baseApk), "classes.dex"], { cwd: path.join(work, "dex") });

  // 5. Align, then sign. Order matters: signing after alignment is what
  //    apksigner expects, and zipalign after signing invalidates v2.
  const alignedApk = path.join(work, "aligned.apk");
  await runTool(tools.zipalign, ["-f", "4", baseApk, alignedApk]);

  // The keystore lives OUTSIDE the work directory, which is wiped on every
  // build. A regenerated key changes the signature, and Android refuses to
  // update an installed app whose signature changed, so a rebuild would break
  // the next install with an error that says nothing about signing.
  const keystore = await ensureKeystore(tools, path.join(path.dirname(outPath), "debug.keystore"));
  await mkdir(path.dirname(outPath), { recursive: true });
  await rm(outPath, { force: true });
  await runTool(tools.java, [
    "-jar", tools.apksignerJar,
    "sign",
    "--ks", keystore,
    "--ks-pass", `pass:${KEYSTORE_PASSWORD}`,
    "--key-pass", `pass:${KEYSTORE_PASSWORD}`,
    "--ks-key-alias", KEY_ALIAS,
    "--out", outPath,
    alignedApk
  ]);

  const info = await stat(outPath);
  return Object.freeze({
    apkPath: outPath,
    packageName: PACKAGE_NAME,
    bytes: info.size,
    sha256: await sha256Of(outPath),
    buildTools: tools.buildToolsVersion,
    platform: tools.platformVersion,
    jdkHome: tools.jdkHome
  });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  try {
    const result = await buildFixtureApk({
      out: flags.get("out") ?? DEFAULT_OUT,
      sdk: flags.get("sdk") ?? null,
      jdk: flags.get("jdk") ?? null
    });

    process.stdout.write(
      `built ${result.apkPath}\n` +
        `package ${result.packageName}\n` +
        `bytes ${result.bytes}\n` +
        `sha256 ${result.sha256}\n` +
        `build-tools ${result.buildTools}, platform ${result.platform}\n`
    );
    return 0;
  } catch (error) {
    if (error instanceof BuildError) {
      process.stderr.write(`${error.code}: ${error.message}\n${JSON.stringify(error.details, null, 2)}\n`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}` || process.argv[1]?.endsWith("build-fixture-apk.mjs")) {
  process.exitCode = await main();
}
