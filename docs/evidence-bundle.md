# Evidence Bundle

Each CLI run writes one run directory below the configured artifact root. The bundle is intended to be readable after the original terminal output is gone.

## Layout

```text
<artifactRoot>/<runId>/
  run.json
  junit.xml
  report.html
  manifest.json
  scenarios/
    <scenarioId>__<surface>/
      plan.json
      evidence/
        network.jsonl
        step-<index>-checkpoint-<label>.png
        failure.png
        video.webm
        trace.zip
        trace-error.json
```

`run.json` is the machine readable verdict. It links each scenario and step to the artifact refs produced during execution. `junit.xml` is generated from the same record. `report.html` is self contained: screenshots are inlined as data URLs, external video and trace artifacts are linked by relative file path, and the report contains no script.

`manifest.json` lists every artifact written by the bundle with byte count and SHA-256 digest.

## Retention

Checkpoint screenshots and `network.jsonl` are retained for passing and failing web scenarios. They are the minimum evidence needed to show what state the scenario reached and what browser traffic occurred.

`video.webm` and `trace.zip` are retained only when the scenario fails. Passing runs discard them during adapter close. This keeps normal bundles small while preserving the high value browser evidence when a failure must be diagnosed.

Failure collection writes `failure.png` at the failing step. The failing step in `run.json` includes that screenshot in its `evidence` array, so the scenario id, step index, error code, locator description, and screenshot can be recovered from the bundle alone.

If trace retention itself fails, the adapter writes `trace-error.json` with a redacted reason instead of hiding the original scenario result.

## Redaction

Redaction is applied at capture time for the network log and again after the Playwright trace archive is written.

The redactor covers:

1. Sensitive request header values, including authorization, cookie, set-cookie, apikey, x-api-key, x-auth-token, proxy-authorization, and x-csrf-token.
2. Sensitive URL query parameter values, including token, access_token, refresh_token, apikey, api_key, key, sig, signature, password, and secret.
3. Registered literal secrets when a caller supplies them to the redactor API.
4. Shape matched bearer tokens and JWT shaped tokens in text.

Trace redaction also rewrites sensitive header names in text entries to `redacted-header` before the archive is retained. The bundle scanner in `src/evidence/scan.mjs` can scan regular files and zip entries for forbidden words and seeded literals.

## Limit

Screenshots and videos show whatever the app rendered. If the application puts a secret on screen, image and video redaction cannot remove it in Phase 2. Operators decide whether those artifacts are attached to CI logs, uploaded, or retained only locally.
