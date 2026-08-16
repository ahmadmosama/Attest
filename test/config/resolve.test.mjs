import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULTS } from "../../src/config/schema.mjs";
import { resolveConfig } from "../../src/config/resolve.mjs";

test("resolveConfig layers defaults, file, env, then flags", () => {
  const config = resolveConfig({
    file: {
      artifactRoot: "from-file",
      scenariosGlob: ["file/**/*.attest.yaml"],
      timeouts: { stepMs: 11111 },
      failOnSkip: false
    },
    env: {
      ATTEST_ARTIFACT_ROOT: "from-env",
      ATTEST_TIMEOUT_SCENARIO_MS: "22222",
      ATTEST_SURFACES: "web,android"
    },
    flags: {
      artifactRoot: "from-flags",
      surfaces: ["ios"],
      app: "https://example.test"
    }
  });

  assert.equal(config.artifactRoot, "from-flags");
  assert.deepEqual(config.scenariosGlob, ["file/**/*.attest.yaml"]);
  assert.equal(config.timeouts.stepMs, 11111);
  assert.equal(config.timeouts.scenarioMs, 22222);
  assert.equal(config.timeouts.preflightMs, DEFAULTS.timeouts.preflightMs);
  assert.equal(config.timeouts.openMs, DEFAULTS.timeouts.openMs);
  assert.equal(config.timeouts.evidenceMs, DEFAULTS.timeouts.evidenceMs);
  assert.equal(config.timeouts.closeMs, DEFAULTS.timeouts.closeMs);
  assert.deepEqual(config.surfaces, ["ios"]);
  assert.equal(config.failOnSkip, false);
  assert.equal(config.app, "https://example.test");
});

test("resolveConfig takes every default from DEFAULTS and deeply freezes the result", () => {
  const config = resolveConfig();

  assert.equal(config.artifactRoot, DEFAULTS.artifactRoot);
  assert.deepEqual(config.scenariosGlob, DEFAULTS.scenariosGlob);
  assert.equal(config.bindingsDir, DEFAULTS.bindingsDir);
  assert.equal(config.app, DEFAULTS.app);
  assert.deepEqual(config.surfaces, DEFAULTS.surfaces);
  assert.deepEqual(config.timeouts, DEFAULTS.timeouts);
  assert.deepEqual(config.web, DEFAULTS.web);
  assert.equal(config.failOnSkip, DEFAULTS.failOnSkip);
  assert.equal(config.concurrency, DEFAULTS.concurrency);
  assert.equal(config.color, DEFAULTS.color);
  assert.equal(config.db, null);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.timeouts), true);
  assert.equal(Object.isFrozen(config.web), true);
  assert.equal(Object.isFrozen(config.web.viewport), true);
  assert.equal(Object.isFrozen(config.surfaces), true);
});

test("resolveConfig validates db blocks and applies declared defaults", () => {
  const config = resolveConfig({
    file: {
      db: {
        allowlist: [
          {
            host: "db.example.test",
            database: "app_test",
            nonProd: true,
            note: "local integration database"
          }
        ]
      }
    }
  });

  assert.deepEqual(config.db.allowlist, [
    {
      host: "db.example.test",
      database: "app_test",
      nonProd: true,
      note: "local integration database"
    }
  ]);
  assert.equal(config.db.rulesFile, null);
  assert.deepEqual(config.db.redaction, { sensitive: [], mode: "hash" });
  assert.equal(config.db.convergeTimeoutMs, 10000);
  assert.equal(config.db.quietPeriodMs, 750);
  assert.equal(config.db.quietPeriodCapMs, 5000);
  assert.equal(config.db.tenantPrefix, "attest");
  assert.equal(config.db.target, null);
  assert.equal(Object.isFrozen(config.db), true);
  assert.equal(Object.isFrozen(config.db.allowlist), true);
  assert.equal(Object.isFrozen(config.db.redaction), true);
});

test("resolveConfig refuses db allowlist entries without a written non production marker", () => {
  assert.throws(
    () =>
      resolveConfig({
        file: {
          db: {
            allowlist: [{ host: "db.example.test", database: "app_test", nonProd: true }]
          }
        }
      }),
    (error) => {
      assert.equal(error.code, "E_CONFIG_INVALID");
      assert.match(JSON.stringify(error.details.issues), /note/);
      return true;
    }
  );

  assert.throws(
    () =>
      resolveConfig({
        file: {
          db: {
            allowlist: [{ host: "db.example.test", database: "app_test", nonProd: false, note: "not enough" }]
          }
        }
      }),
    (error) => {
      assert.equal(error.code, "E_CONFIG_INVALID");
      assert.match(JSON.stringify(error.details.issues), /nonProd/);
      return true;
    }
  );
});

test("resolveConfig refuses db.url and names ATTEST_DB_URL", () => {
  assert.throws(
    () =>
      resolveConfig({
        file: {
          db: {
            allowlist: [],
            url: "postgres://user:secret@db.example.test/app_test"
          }
        }
      }),
    (error) => {
      assert.equal(error.code, "E_CONFIG_INVALID");
      assert.match(JSON.stringify(error.details.issues), /ATTEST_DB_URL/);
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    }
  );
});

test("resolveConfig resolves ATTEST_DB_URL into a validated target without storing the string", () => {
  const config = resolveConfig({
    file: {
      db: {
        allowlist: [
          {
            host: "db.example.test",
            database: "app_test",
            nonProd: true,
            note: "local integration database"
          }
        ]
      }
    },
    env: {
      ATTEST_DB_URL: "postgres://user:secret@db.example.test/app_test?sslmode=require"
    }
  });

  assert.equal(config.db.target.host, "db.example.test");
  assert.equal(config.db.target.database, "app_test");
  assert.equal(config.db.target.user, "user");
  assert.equal(config.db.target.password, undefined);
  assert.equal(JSON.stringify(config).includes("secret"), false);
  assert.equal(JSON.stringify(config).includes("sslmode"), false);
  assert.equal(Object.isFrozen(config.db.target), true);
});

test("resolveConfig refuses ATTEST_DB_URL when no allowlist is configured", () => {
  assert.throws(
    () =>
      resolveConfig({
        env: {
          ATTEST_DB_URL: "postgres://user:secret@db.example.test/app_test"
        }
      }),
    (error) => {
      assert.equal(error.code, "E_DB_TARGET_NOT_ALLOWLISTED");
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    }
  );

  assert.throws(
    () =>
      resolveConfig({
        file: {
          db: {
            allowlist: []
          }
        },
        env: {
          ATTEST_DB_URL: "postgres://user:secret@db.example.test/app_test"
        }
      }),
    (error) => {
      assert.equal(error.code, "E_DB_TARGET_NOT_ALLOWLISTED");
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    }
  );
});

test("resolveConfig refuses ATTEST_DB_URL on port 6543", () => {
  assert.throws(
    () =>
      resolveConfig({
        file: {
          db: {
            allowlist: [
              {
                host: "db.example.test",
                database: "app_test",
                nonProd: true,
                note: "local integration database"
              }
            ]
          }
        },
        env: {
          ATTEST_DB_URL: "postgres://user:secret@db.example.test:6543/app_test"
        }
      }),
    (error) => {
      assert.equal(error.code, "E_DB_POOLER_PORT");
      assert.match(error.message, /5432/);
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    }
  );
});

test("resolveConfig fills partial timeouts and web blocks", () => {
  const config = resolveConfig({
    file: {
      timeouts: { stepMs: 5000 },
      web: {
        viewport: { width: 1440 }
      }
    }
  });

  assert.deepEqual(config.timeouts, {
    ...DEFAULTS.timeouts,
    stepMs: 5000
  });
  assert.deepEqual(config.web, {
    ...DEFAULTS.web,
    viewport: {
      ...DEFAULTS.web.viewport,
      width: 1440
    }
  });
});

test("resolveConfig rejects chromium and unknown nested config keys", () => {
  assert.throws(
    () =>
      resolveConfig({
        file: {
          web: { channel: "chromium" }
        }
      }),
    (error) => {
      assert.equal(error.code, "E_CONFIG_INVALID");
      assert.match(JSON.stringify(error.details.issues), /WEB-01/);
      return true;
    }
  );

  assert.throws(
    () =>
      resolveConfig({
        file: {
          timeouts: { openMs: 60000, unknownMs: 1 }
        }
      }),
    (error) => {
      assert.equal(error.code, "E_CONFIG_INVALID");
      assert.match(JSON.stringify(error.details.issues), /Unrecognized key/);
      return true;
    }
  );

  assert.throws(
    () =>
      resolveConfig({
        file: {
          web: { testIdAttribute: "data-test", unknown: true }
        }
      }),
    (error) => {
      assert.equal(error.code, "E_CONFIG_INVALID");
      assert.match(JSON.stringify(error.details.issues), /Unrecognized key/);
      return true;
    }
  );
});

test("resolveConfig rejects secret shaped flag values", () => {
  assert.throws(
    () =>
      resolveConfig({
        flags: {
          apiToken: "a".repeat(32)
        }
      }),
    (error) => {
      assert.equal(error.code, "E_SECRET_IN_FLAG");
      return true;
    }
  );

  assert.throws(
    () =>
      resolveConfig({
        flags: {
          database: "postgres://user:pass@example.test/app"
        }
      }),
    (error) => {
      assert.equal(error.code, "E_SECRET_IN_FLAG");
      return true;
    }
  );
});
