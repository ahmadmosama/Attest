const EMPTY_DETAILS = Object.freeze({});

function assertSafeErrorInput(code, message) {
  if (typeof code !== "string" || code.length === 0) {
    throw new TypeError("AttestError code must be a non empty string");
  }

  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("AttestError message must be a non empty string");
  }
}

function freezeDetails(details) {
  if (details === undefined || details === null) {
    return EMPTY_DETAILS;
  }

  if (typeof details !== "object" || Array.isArray(details)) {
    throw new TypeError("AttestError details must be an object");
  }

  return Object.freeze({ ...details });
}

export class AttestError extends Error {
  constructor(code, message, details = EMPTY_DETAILS) {
    assertSafeErrorInput(code, message);
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = freezeDetails(details);
  }

  toJSON() {
    return Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details
    });
  }
}

export class InfraError extends AttestError {}

export class UsageError extends AttestError {}

export class UnsupportedOpError extends AttestError {}
