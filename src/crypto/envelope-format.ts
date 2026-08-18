// RepoBD envelope wire format — the shape of what crosses the network.
//
// Deliberately free of any cryptographic runtime: no `crypto.subtle`, no
// `CryptoKey`, no key generation, import, export, encryption, decryption, or
// plaintext decoding. That keeps this module usable by the Worker, which must
// be able to validate a stored envelope without acquiring the ability to
// decrypt one. The cryptographic operations live in `envelope.ts`.
//
// This is the single source of truth for canonical base64url validation.
// Do not restate these rules elsewhere.
//
// Nothing here logs, prints, or embeds plaintext or key material — including
// in error messages.

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "A256GCM";

/** Maximum plaintext size, measured in encoded UTF-8 bytes (64 KiB). */
export const MAX_PLAINTEXT_BYTES = 65536;

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_LENGTH_BITS = 128;
export const TAG_BYTES = TAG_LENGTH_BITS / 8;

// AES-GCM ciphertext is the plaintext plus the appended authentication tag,
// so a ciphertext longer than this cannot represent a plaintext within the
// 64 KiB limit and is rejected before any decryption is attempted.
export const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + TAG_BYTES;

/**
 * The serialized form handed to the server. Carries no key material and no
 * plaintext metadata such as the original length.
 */
export interface SecretEnvelope {
  v: number;
  alg: string;
  /** base64url, IV_BYTES bytes. */
  iv: string;
  /** base64url, ciphertext with the authentication tag appended. */
  ct: string;
}

/**
 * The payload exceeds the 64 KiB limit. The message names only the limit:
 * some rejections happen on the encoded length before anything is decoded,
 * so no verified plaintext size exists to report.
 */
export class PlaintextTooLargeError extends Error {
  constructor() {
    super(
      `payload exceeds the maximum plaintext size of ${MAX_PLAINTEXT_BYTES} bytes`,
    );
    this.name = "PlaintextTooLargeError";
  }
}

export class EnvelopeFormatError extends Error {
  constructor(detail: string) {
    super(`invalid envelope: ${detail}`);
    this.name = "EnvelopeFormatError";
  }
}

export class UnsupportedEnvelopeVersionError extends Error {
  constructor(detail: string) {
    super(`unsupported envelope: ${detail}`);
    this.name = "UnsupportedEnvelopeVersionError";
  }
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url characters needed to encode `byteLength` bytes. */
export function base64UrlLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

// Byte-at-a-time conversion rather than String.fromCharCode(...bytes): a
// spread over a 64 KiB array would risk a call-stack overflow.
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Strict base64url decode: rejects non-alphabet characters (including `=`
 * padding, which this module never emits), impossible lengths, and
 * non-canonical encodings whose trailing bits are not zero.
 *
 * Callers must bound the encoded length first — `decodeExactly` and
 * `decodeCiphertext` are the only entry points, and both do — because this
 * function validates, allocates, and re-encodes the whole input.
 */
function fromBase64Url(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") {
    throw new EnvelopeFormatError(`${field} is not a string`);
  }
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new EnvelopeFormatError(`${field} is not valid base64url`);
  }
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new EnvelopeFormatError(`${field} is not valid base64url`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (toBase64Url(bytes) !== value) {
    throw new EnvelopeFormatError(`${field} is not canonical base64url`);
  }
  return bytes;
}

/**
 * Decodes a field of exactly known size. The encoded length is checked
 * first so an oversized untrusted string is rejected before any validation,
 * allocation, or canonical re-encoding work.
 */
export function decodeExactly(
  value: unknown,
  field: string,
  expectedBytes: number,
): Uint8Array {
  if (typeof value !== "string") {
    throw new EnvelopeFormatError(`${field} is not a string`);
  }
  const expectedLength = base64UrlLength(expectedBytes);
  if (value.length !== expectedLength) {
    throw new EnvelopeFormatError(
      `${field} must be ${expectedLength} base64url characters for ${expectedBytes} bytes, got ${value.length}`,
    );
  }
  const bytes = fromBase64Url(value, field);
  if (bytes.length !== expectedBytes) {
    throw new EnvelopeFormatError(
      `${field} must decode to ${expectedBytes} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

/**
 * Decodes an envelope ciphertext. The 64 KiB payload boundary is applied to
 * the encoded length first, so an oversized untrusted string never reaches
 * decoding, and again to the decoded bytes.
 *
 * The lower bound is a shape rule, not a size limit: AES-GCM appends a
 * 128-bit tag, so no ciphertext this format can describe is shorter than
 * TAG_BYTES — an empty or truncated `ct` is malformed, not merely undersized.
 */
export function decodeCiphertext(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") {
    throw new EnvelopeFormatError(`${field} is not a string`);
  }
  if (value.length > base64UrlLength(MAX_CIPHERTEXT_BYTES)) {
    throw new PlaintextTooLargeError();
  }
  const bytes = fromBase64Url(value, field);
  if (bytes.length > MAX_CIPHERTEXT_BYTES) {
    throw new PlaintextTooLargeError();
  }
  if (bytes.length < TAG_BYTES) {
    throw new EnvelopeFormatError(
      `${field} must be at least ${TAG_BYTES} bytes to carry an authentication tag, got ${bytes.length}`,
    );
  }
  return bytes;
}

export function assertSupported(envelope: SecretEnvelope): void {
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new UnsupportedEnvelopeVersionError(`version ${String(envelope.v)}`);
  }
  if (envelope.alg !== ENVELOPE_ALG) {
    throw new UnsupportedEnvelopeVersionError(`algorithm ${envelope.alg}`);
  }
}

/**
 * Serializes an exact projection of the approved fields. Structural typing
 * does not stop a runtime object from carrying extra enumerable properties,
 * and stringifying the object wholesale would put anything else it happens
 * to hold — a key, a plaintext — on the wire.
 */
export function serializeEnvelope(envelope: SecretEnvelope): string {
  return JSON.stringify({
    v: envelope.v,
    alg: envelope.alg,
    iv: envelope.iv,
    ct: envelope.ct,
  });
}

export function parseEnvelope(json: string): SecretEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new EnvelopeFormatError("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeFormatError("not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const version = record["v"];
  const alg = record["alg"];
  const iv = record["iv"];
  const ct = record["ct"];
  if (typeof version !== "number") {
    throw new EnvelopeFormatError("v is not a number");
  }
  if (typeof alg !== "string") {
    throw new EnvelopeFormatError("alg is not a string");
  }
  if (typeof iv !== "string") {
    throw new EnvelopeFormatError("iv is not a string");
  }
  if (typeof ct !== "string") {
    throw new EnvelopeFormatError("ct is not a string");
  }
  const envelope: SecretEnvelope = { v: version, alg, iv, ct };
  assertSupported(envelope);
  decodeExactly(iv, "iv", IV_BYTES);
  decodeCiphertext(ct, "ct");
  return envelope;
}
