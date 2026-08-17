# Surface Adapter Conformance

Phase 4 adds one shared surface adapter contract suite. The fake and web adapters both run it
today. Phase 5 Android and Phase 7 iOS must run the same suite before their adapter specific
tests are trusted.

## Purpose

The surface port exists so one scenario can drive web, Android, and iOS without becoming a
web recording. Adapter specific tests are still useful, but they do not define the port.
`test/conformance/surface-port.mjs` defines the shared clauses every surface adapter must
satisfy.

The suite is parameterised by an adapter factory:

```js
runSurfaceConformance({
  name: "android",
  createAdapter: async ({ ctx, t }) => createAndroidSurface({ ctx, t }),
  createContext: async () => ({ ctx, cleanup }),
  capabilities: ANDROID_SURFACE_SUPPORTS,
  describe,
  test,
  skip,
  isSkippableSetupError
});
```

`createAdapter` must return a fresh adapter for each case. The suite never shares one adapter
between clauses. Shared adapter state is a contract failure, because retries, evidence, and
close handling must not depend on test order.

## Contract Clauses

`describeCapabilities` returns a frozen descriptor. Its `surface` must match the configured
name, `supports` and `degraded` must be frozen arrays, and `has(capability)` must be the
declared capability predicate.

Every method listed by `SURFACE_PORT_METHODS` must exist and be a function. The current port
methods are `describeCapabilities`, `preflight`, `open`, `execute`, `collectEvidence`, and
`close`.

`preflight(ctx)` must return a frozen `{ ok: true }` result for a usable target. If the target
is unavailable for a declared infrastructure reason, the conformance invocation may translate
that setup failure into a stated skip.

A supported operation must return a frozen ok result. The default conformance operation is
`raw`, so an adapter that does not declare `raw_escape` must provide another supported
operation and name its required capability.

An operation that requires a missing capability must throw `UnsupportedOpError` with code
`E_UNSUPPORTED_OP`. It must not pass, return ok, or silently no op.

An operation with a locator that cannot resolve must fail through the project taxonomy. That
means an `AttestError` code beginning with `E_`, not a raw Playwright, adb, xcrun, or driver
exception.

Evidence capture for `failure` must return a frozen artifact reference. The same must be true
after a step has already failed, because failed scenarios are the ones operators inspect.

`close(session)` must be idempotent. Calling it twice must not throw and must return a frozen
ok result.

An already aborted signal must stop `execute` promptly and surface the abort reason. The
adapter must not hide cancellation behind a generic action failure.

## Skips

A clause may be skipped only when it requires a capability or infrastructure that the adapter
does not declare or cannot access. The skip reason must name the missing capability or the
unavailable infrastructure.

A clause may never be deleted from the conformance suite to make an adapter green. Deleting a
clause weakens the port for every future adapter. If a clause does not fit a new surface, the
adapter contract or its declared capabilities need to be corrected explicitly.

The fake adapter path must run without an app, a browser, or a database. That keeps the shared
contract runnable on any operating system and gives Phase 5 Android and Phase 7 iOS a cheap
first check before emulator or simulator work starts.
