import { spawn } from "node:child_process";

import { AttestError, InfraError } from "../../errors.mjs";

export class AdbError extends AttestError {}

const MAX_CAPTURED_BYTES = 1_048_576;

function assertCommand(command) {
  if (command === null || typeof command !== "object") {
    throw new TypeError("runAdb requires a command object");
  }

  if (typeof command.command !== "string" || command.command.length === 0) {
    throw new TypeError("runAdb requires a command path");
  }

  // The single most important check in this file. Everything upstream builds
  // argv arrays precisely so nothing ever reaches a shell, and this is where
  // that guarantee is enforced rather than assumed.
  if (!Array.isArray(command.args) || command.args.some((item) => typeof item !== "string")) {
    throw new TypeError("runAdb requires args to be an array of strings");
  }

  return command;
}

function aborted(argv) {
  return new InfraError("E_ADB_ABORTED", "adb invocation was aborted.", { argv });
}

function truncate(buffers) {
  const joined = Buffer.concat(buffers);
  const slice = joined.length > MAX_CAPTURED_BYTES ? joined.subarray(0, MAX_CAPTURED_BYTES) : joined;
  return { text: slice.toString("utf8"), bytes: joined };
}

/**
 * The only place in the codebase that spawns adb.
 *
 * `shell` is false explicitly. On Git Bash a shell rewrites device side paths
 * (`/sdcard/ui.xml` becomes a Windows path inside the shell command) and then
 * breaks host side paths in the opposite direction once that is disabled. The
 * two fixes conflict, so the answer is to never involve a shell at all. It is
 * also what makes argument injection structurally impossible here.
 */
export async function runAdb(command, { signal, encoding = "utf8" } = {}) {
  const { command: binary, args, env } = assertCommand(command);

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(aborted(args));
      return;
    }

    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(aborted(args));
    };

    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      reject(
        new InfraError("E_ADB_SPAWN_FAILED", "Could not start adb.", {
          argv: args,
          binary,
          reason: error.message,
          remediation: "Set ANDROID_HOME or ANDROID_SDK_ROOT to an SDK directory containing platform-tools."
        })
      );
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);

      const out = truncate(stdoutChunks);
      const err = truncate(stderrChunks);

      if (code !== 0) {
        // argv and stderr are included because that is what a human needs to
        // diagnose. The environment is deliberately NOT included: it carries
        // the whole process env and would leak secrets into an artifact.
        reject(
          new AdbError("E_ADB_COMMAND_FAILED", "adb command failed.", {
            exitCode: code,
            argv: args,
            stderr: err.text
          })
        );
        return;
      }

      resolve(
        Object.freeze({
          exitCode: code,
          stdout: encoding === "buffer" ? out.bytes : out.text,
          stderr: err.text
        })
      );
    });
  });
}
