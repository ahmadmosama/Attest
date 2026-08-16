import { UsageError } from "../errors.mjs";

export const REDACTED = "[REDACTED]";
const UNPARSEABLE_URL = "[UNPARSEABLE_URL]";
const ENCODED_REDACTED = encodeURIComponent(REDACTED);
const MIN_SECRET_LENGTH = 8;

export const DEFAULT_SECRET_HEADERS = Object.freeze([
  "authorization",
  "cookie",
  "set-cookie",
  "apikey",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
  "x-csrf-token"
]);

export const DEFAULT_SECRET_QUERY_PARAMS = Object.freeze([
  "token",
  "access_token",
  "refresh_token",
  "apikey",
  "api_key",
  "key",
  "sig",
  "signature",
  "password",
  "secret"
]);

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi;

function assertStringArray(values, name) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${name} must be an array`);
  }

  for (const value of values) {
    if (typeof value !== "string") {
      throw new TypeError(`${name} entries must be strings`);
    }
  }
}

function lowerSet(values) {
  return new Set(values.map((value) => value.toLowerCase()));
}

function normalizeSecrets(secrets) {
  assertStringArray(secrets, "secrets");

  const unique = new Set();
  for (const secret of secrets) {
    if (secret.length === 0) {
      throw new UsageError("E_EMPTY_SECRET", "Registered redaction secrets must not be empty");
    }

    if (secret.length >= MIN_SECRET_LENGTH) {
      unique.add(secret);
    }
  }

  return Object.freeze([...unique].toSorted((left, right) => right.length - left.length));
}

function replaceLiteral(value, literal, replacement) {
  return value.split(literal).join(replacement);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function coerceHeaderValue(value, redactValue) {
  if (value === null || value === undefined) {
    return value;
  }

  return redactValue(value);
}

function redactSearch(url, queryDenySet, redactText) {
  const params = new URLSearchParams();

  for (const [name, value] of url.searchParams.entries()) {
    if (queryDenySet.has(name.toLowerCase())) {
      params.append(name, REDACTED);
    } else {
      params.append(name, redactText(value));
    }
  }

  url.search = params.toString();
  return redactText(url.toString()).replaceAll(ENCODED_REDACTED, REDACTED);
}

export function createRedactor({
  secrets = [],
  headers = DEFAULT_SECRET_HEADERS,
  queryParams = DEFAULT_SECRET_QUERY_PARAMS
} = {}) {
  assertStringArray(headers, "headers");
  assertStringArray(queryParams, "queryParams");

  const secretValues = normalizeSecrets(secrets);
  const headerDenySet = lowerSet(headers);
  const queryDenySet = lowerSet(queryParams);

  function redactText(value) {
    if (typeof value !== "string") {
      throw new TypeError("redactText requires a string");
    }

    let redacted = value;
    for (const secret of secretValues) {
      redacted = replaceLiteral(redacted, secret, REDACTED);
    }

    return redacted.replace(JWT_PATTERN, REDACTED).replace(BEARER_PATTERN, REDACTED);
  }

  function redactValue(value) {
    if (typeof value === "string") {
      return redactText(value);
    }

    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => redactValue(item)));
    }

    if (isPlainObject(value)) {
      return Object.freeze(
        Object.fromEntries(
          Object.entries(value).map(([key, item]) => [redactText(key), redactValue(item)])
        )
      );
    }

    return value;
  }

  function redactHeaders(headersObject) {
    if (!isPlainObject(headersObject)) {
      throw new TypeError("redactHeaders requires a plain object");
    }

    return Object.freeze(
      Object.fromEntries(
        Object.entries(headersObject).map(([name, value]) => [
          name,
          headerDenySet.has(name.toLowerCase()) ? REDACTED : coerceHeaderValue(value, redactValue)
        ])
      )
    );
  }

  function redactUrl(urlString) {
    if (typeof urlString !== "string") {
      throw new TypeError("redactUrl requires a string");
    }

    try {
      return redactSearch(new URL(urlString), queryDenySet, redactText);
    } catch {
      return UNPARSEABLE_URL;
    }
  }

  return Object.freeze({
    redactHeaders,
    redactUrl,
    redactText,
    redactValue
  });
}
