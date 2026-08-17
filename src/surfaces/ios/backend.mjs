import { InfraError } from "../../errors.mjs";
import { IDB_COMMANDS, buildIdbCommand, normalizeElements, parseTargets } from "./idb.mjs";

/**
 * The idb backed `deps` for the iOS surface adapter.
 *
 * The adapter has always taken `describeElements`, `tap` and `type` as injected
 * seams, with the note that they come "from the CI harness on the macOS
 * runner". This is that harness, written down: the seams are filled by real idb
 * invocations instead of by a promise that someone will fill them later.
 *
 * `runIdb` is itself injected. Everything above it is command construction and
 * response normalisation, so the whole backend is asserted on Windows against
 * committed transcripts, and only the `idb` process is absent.
 */

function requireRunner(runIdb) {
  if (typeof runIdb !== "function") {
    throw new InfraError("E_IDB_UNAVAILABLE", "No idb runner is available", {
      remediation:
        "iOS executes only on a macOS runner with `idb` installed (`brew tap facebook/fb && brew install idb-companion`, " +
        "`pipx install fb-idb`). On any other host the adapter runs against an injected transport, which is IOS-02."
    });
  }

  return runIdb;
}

function textOf(result) {
  if (typeof result === "string") {
    return result;
  }

  return String(result?.stdout ?? "");
}

/**
 * Build the deps object.
 *
 * `idbPath` exists because the companion is sometimes installed somewhere that
 * is not on PATH, and a backend that can only find one binary in one place is a
 * backend that does not run on somebody else's runner.
 */
export function createIdbBackend({ runIdb, idbPath = "idb" } = {}) {
  const options = Object.freeze({ idbPath });

  async function call(kind, input, callOptions = {}) {
    return requireRunner(runIdb)(buildIdbCommand(kind, input, options), callOptions);
  }

  return Object.freeze({
    async listTargets({ signal } = {}) {
      return parseTargets(textOf(await call(IDB_COMMANDS.listTargets, {}, { signal })));
    },

    async describeElements({ deviceId, signal } = {}) {
      const result = await call(IDB_COMMANDS.describeAll, { udid: deviceId }, { signal });
      // Refuses a non array rather than coercing to []. An empty tree and an
      // unparseable one are different facts, and flattening them is how "the
      // element is not there" gets reported for a broken companion.
      return normalizeElements(textOf(result));
    },

    async tap({ deviceId, point, longPress = false, signal } = {}) {
      return call(
        IDB_COMMANDS.tap,
        {
          udid: deviceId,
          x: Math.round(point?.x),
          y: Math.round(point?.y),
          // idb expresses a long press as a held tap. 0.5s is the iOS system
          // threshold for a recognised long press gesture.
          durationSeconds: longPress === true ? 0.5 : 0.1
        },
        { signal }
      );
    },

    async type({ deviceId, text, signal } = {}) {
      return call(IDB_COMMANDS.text, { udid: deviceId, text: String(text ?? "") }, { signal });
    },

    async swipe({ deviceId, from, to, signal } = {}) {
      return call(
        IDB_COMMANDS.swipe,
        {
          udid: deviceId,
          x1: Math.round(from?.x),
          y1: Math.round(from?.y),
          x2: Math.round(to?.x),
          y2: Math.round(to?.y)
        },
        { signal }
      );
    },

    async launchApp({ deviceId, bundleId, foregroundIfRunning = false, signal } = {}) {
      return call(IDB_COMMANDS.launchApp, { udid: deviceId, bundleId, foregroundIfRunning }, { signal });
    },

    async terminateApp({ deviceId, bundleId, signal } = {}) {
      return call(IDB_COMMANDS.terminateApp, { udid: deviceId, bundleId }, { signal });
    },

    async installApp({ deviceId, appPath, signal } = {}) {
      return call(IDB_COMMANDS.installApp, { udid: deviceId, appPath }, { signal });
    },

    async screenshot({ deviceId, outputPath, signal } = {}) {
      return call(IDB_COMMANDS.screenshot, { udid: deviceId, outputPath }, { signal });
    }
  });
}
