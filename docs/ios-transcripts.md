# iOS Command Transcripts

The iOS transcript tests keep simulator command construction visible on every development
machine. They exist because an adapter exercised only on rare macOS runs can drift without
showing up in the normal Windows gate.

`src/surfaces/ios/commands.mjs` builds command descriptions only. Each description is frozen
data with `command`, `args`, and `env`. The args are arrays, never shell strings. The module
does not import process execution APIs, does not call `xcrun`, and does not contact a
simulator.

The committed snapshot in `test/surfaces/ios/__snapshots__/ios-commands.json` records the
ordered lifecycle Phase 7 will execute on macOS: list runtimes, assert the pinned runtime,
boot the named simulator, install the unpacked `.app`, launch it, take a screenshot, and
shut the simulator down.

A passing snapshot proves command construction only. It does not prove that Xcode exists,
that a runtime is installed, that a simulator can boot, or that the app launches. Phase 7 is
where these commands execute on a macOS runner with pinned Xcode and a pinned runtime.

Update the snapshot only after reviewing the command diff:

```powershell
node test/surfaces/ios/transcript.test.mjs update-snapshot
```

Then run:

```powershell
node test/surfaces/ios/transcript.test.mjs
```

The test also asserts that a real `ios` surface run on Windows still refuses execution with
`E_ADAPTER_NOT_IMPLEMENTED`. These transcripts do not make local iOS execution available.
