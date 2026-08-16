import { REDACTED } from "../../evidence/redact.mjs";

const DEFAULT_LIMIT = 2000;
const UNKNOWN_STATUS = null;

function assertPage(page) {
  if (
    page === null ||
    typeof page !== "object" ||
    typeof page.on !== "function" ||
    typeof page.off !== "function"
  ) {
    throw new TypeError("attachNetworkCollector requires a Playwright page");
  }
}

function assertRedactor(redactor) {
  if (
    redactor === null ||
    typeof redactor !== "object" ||
    typeof redactor.redactHeaders !== "function" ||
    typeof redactor.redactUrl !== "function"
  ) {
    throw new TypeError("attachNetworkCollector requires a redactor");
  }
}

function normalizeLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("network collector limit must be a positive safe integer");
  }

  return limit;
}

function nowMs() {
  return Date.now();
}

function requestHeaders(request) {
  if (typeof request?.headers !== "function") {
    return Object.freeze({});
  }

  const headers = request.headers();
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    return Object.freeze({});
  }

  return Object.freeze(
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  );
}

function safeRedactHeaders(redactor, headers) {
  try {
    return redactor.redactHeaders(headers);
  } catch {
    return Object.freeze(
      Object.fromEntries(Object.keys(headers).map((name) => [name, REDACTED]))
    );
  }
}

function safeRedactUrl(redactor, url) {
  try {
    return redactor.redactUrl(url);
  } catch {
    return REDACTED;
  }
}

function methodFor(request) {
  try {
    return typeof request?.method === "function" ? String(request.method()) : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function urlFor(request) {
  try {
    return typeof request?.url === "function" ? String(request.url()) : "";
  } catch {
    return "";
  }
}

function resourceTypeFor(request) {
  try {
    return typeof request?.resourceType === "function" ? String(request.resourceType()) : "other";
  } catch {
    return "other";
  }
}

function responseStatus(response) {
  try {
    return typeof response?.status === "function" ? response.status() : UNKNOWN_STATUS;
  } catch {
    return UNKNOWN_STATUS;
  }
}

function responseContentType(response) {
  try {
    const headers =
      typeof response?.headers === "function" && response.headers() !== null ? response.headers() : {};
    const value = headers["content-type"] ?? headers["Content-Type"];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function failedRequestText(request) {
  try {
    const failure = typeof request?.failure === "function" ? request.failure() : null;
    return typeof failure?.errorText === "string" && failure.errorText.length > 0
      ? failure.errorText
      : "request failed";
  } catch {
    return "request failed";
  }
}

function entryFor(request, redactor) {
  return {
    method: methodFor(request),
    url: safeRedactUrl(redactor, urlFor(request)),
    resourceType: resourceTypeFor(request),
    headers: safeRedactHeaders(redactor, requestHeaders(request)),
    status: UNKNOWN_STATUS,
    contentType: undefined,
    startedAtMs: nowMs(),
    durationMs: undefined,
    failure: undefined
  };
}

function frozenEntry(entry) {
  return Object.freeze(
    Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))
  );
}

function updateDuration(entry) {
  entry.durationMs = Math.max(0, nowMs() - entry.startedAtMs);
}

export function attachNetworkCollector(page, { redactor, limit = DEFAULT_LIMIT } = {}) {
  assertPage(page);
  assertRedactor(redactor);
  const maxEntries = normalizeLimit(limit);
  const entries = [];
  const byRequest = new WeakMap();
  let truncated = 0;
  let detached = false;

  function onRequest(request) {
    if (detached) {
      return;
    }

    if (entries.length >= maxEntries) {
      truncated += 1;
      return;
    }

    const entry = entryFor(request, redactor);
    entries.push(entry);
    if (request !== null && typeof request === "object") {
      byRequest.set(request, entry);
    }
  }

  function onResponse(response) {
    if (detached) {
      return;
    }

    let request;
    try {
      request = typeof response?.request === "function" ? response.request() : null;
    } catch {
      request = null;
    }

    const entry = request === null ? undefined : byRequest.get(request);
    if (entry === undefined) {
      return;
    }

    entry.status = responseStatus(response);
    entry.contentType = responseContentType(response);
    updateDuration(entry);
  }

  function onRequestFailed(request) {
    if (detached) {
      return;
    }

    const entry = request === null || typeof request !== "object" ? undefined : byRequest.get(request);
    if (entry === undefined) {
      return;
    }

    entry.failure = safeRedactUrl(
      { redactUrl: (value) => redactor.redactText(value) },
      failedRequestText(request)
    );
    updateDuration(entry);
  }

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  return Object.freeze({
    entries() {
      const snapshot = entries.map(frozenEntry);
      Object.defineProperty(snapshot, "truncated", {
        value: truncated,
        enumerable: false
      });
      return Object.freeze(snapshot);
    },
    truncated() {
      return truncated;
    },
    detach() {
      if (detached) {
        return;
      }

      detached = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    }
  });
}
