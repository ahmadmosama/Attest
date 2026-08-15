import { readFileSync } from "node:fs";
import path from "node:path";

import { UsageError } from "../errors.mjs";

export const APP_ARTIFACT_KINDS = Object.freeze(["web_url", "android_apk", "ios_app_bundle"]);

const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;

function acceptedKindsText() {
  return "accepted kinds are web URL, Android .apk, iOS Simulator .app directory, or zipped .app bundle";
}

function unknownArtifact(value, reason) {
  throw new UsageError("E_UNKNOWN_APP_ARTIFACT", `Unknown app artifact '${value}': ${acceptedKindsText()}`, {
    value,
    reason
  });
}

function iosDeviceArtifact(value) {
  throw new UsageError(
    "E_IOS_DEVICE_ARTIFACT",
    `'${value}' is a device build. The iOS Simulator cannot install a device .ipa. Build for ` +
      "`generic/platform=iOS Simulator` and pass the resulting .app bundle " +
      "(a directory, or that directory zipped) instead.",
    { value }
  );
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function zipEntryNames(buffer) {
  const names = [];
  for (let offset = 0; offset <= buffer.length - 46; offset += 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > buffer.length) {
      continue;
    }

    names.push(buffer.subarray(nameStart, nameEnd).toString("utf8"));
    offset = nameEnd + extraLength + commentLength - 1;
  }
  return names;
}

function containsTopLevelApp(entries) {
  return entries.some((entry) => /^[^/\\]+\.app(?:[/\\]|$)/i.test(entry));
}

function classifyZip(value) {
  let buffer;
  try {
    buffer = readFileSync(value);
  } catch (error) {
    throw new UsageError("E_APP_ARTIFACT_READ_FAILED", `Could not read app artifact '${value}'`, {
      value,
      reason: error.message
    });
  }

  if (!containsTopLevelApp(zipEntryNames(buffer))) {
    unknownArtifact(value, "zip_without_top_level_app");
  }

  return Object.freeze({ kind: "ios_app_bundle", path: value, surface: "ios" });
}

export function classifyAppArtifact(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    unknownArtifact(String(value), "empty");
  }

  if (isHttpUrl(value)) {
    return Object.freeze({ kind: "web_url", url: value, surface: "web" });
  }

  const lower = value.toLowerCase();
  if (lower.endsWith(".ipa")) {
    iosDeviceArtifact(value);
  }
  if (lower.endsWith(".apk")) {
    return Object.freeze({ kind: "android_apk", path: value, surface: "android" });
  }
  if (lower.endsWith(".app")) {
    return Object.freeze({ kind: "ios_app_bundle", path: value, surface: "ios" });
  }
  if (path.extname(lower) === ".zip") {
    return classifyZip(value);
  }

  unknownArtifact(value, "unsupported_extension");
}
