// RepoBD crypto envelope — Phase 1, local-only proof.
//
// Uses only native Web Crypto and browser-compatible globals, so the same
// module can later serve both the CLI (decrypt) and the web sender
// (encrypt). The RepoBD server never runs this code: it never receives the
// key or the plaintext. See docs/SECURITY_INVARIANTS.md.
//
// Nothing here logs, prints, or embeds plaintext or key material — including
// in error messages.

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "A256GCM";

/** Maximum plaintext size, measured in encoded UTF-8 bytes (64 KiB). */
export const MAX_PLAINTEXT_BYTES = 65536;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_LENGTH_BITS = 128;
const TAG_BYTES = TAG_LENGTH_BITS / 8;

// AES-GCM ciphertext is the plaintext plus the appended authentication tag,
// so a ciphertext longer than this cannot represent a plaintext within the
// 64 KiB limit and is rejected before any decryption is attempted.
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + TAG_BYTES;

/**
 * `CryptoKey` is not a global type under every runtime's TypeScript setup —
 * Node exposes it only through `node:crypto`. Deriving it from the ambient
 * Web Crypto implementation keeps this module free of runtime-specific
 * imports and lets the same source typecheck for Node and the browser.
 */
export type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

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

/**
 * Authenticated decryption failed. Deliberately does not distinguish a wrong
 * key from tampered ciphertext or a tampered IV.
 */
export class DecryptionFailedError extends Error {
  constructor() {
    super("decryption failed");
    this.name = "DecryptionFailedError";
  }
}

/** The supplied key is not the AES-256-GCM key this envelope version declares. */
export class UnsupportedKeyError extends Error {
  constructor(detail: string) {
    super(`unsupported key: ${detail}`);
    this.name = "UnsupportedKeyError";
  }
}

/**
 * The authenticated payload is not valid UTF-8. The payload contract is
 * text-only, so this fails closed rather than substituting replacement
 * characters. Carries no payload bytes.
 */
export class InvalidPlaintextEncodingError extends Error {
  constructor() {
    super("decrypted payload is not valid UTF-8");
    this.name = "InvalidPlaintextEncodingError";
  }
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url characters needed to encode `byteLength` bytes. */
function base64UrlLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

// Byte-at-a-time conversion rather than String.fromCharCode(...bytes): a
// spread over a 64 KiB array would risk a call-stack overflow.
function toBase64Url(bytes: Uint8Array): string {
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
function decodeExactly(
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
 */
function decodeCiphertext(value: unknown, field: string): Uint8Array {
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
  return bytes;
}

/**
 * `alg: "A256GCM"` is a claim about the key, so both cryptographic entry
 * points verify it. Web Crypto itself would happily use an externally
 * created AES-128/192-GCM key here.
 */
function assertAes256GcmKey(key: WebCryptoKey): void {
  const algorithm = key.algorithm as { name?: unknown; length?: unknown };
  if (algorithm.name !== "AES-GCM") {
    throw new UnsupportedKeyError(`algorithm ${String(algorithm.name)}`);
  }
  if (algorithm.length !== KEY_BYTES * 8) {
    throw new UnsupportedKeyError(`${String(algorithm.length)}-bit key`);
  }
}

function assertSupported(envelope: SecretEnvelope): void {
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new UnsupportedEnvelopeVersionError(`version ${String(envelope.v)}`);
  }
  if (envelope.alg !== ENVELOPE_ALG) {
    throw new UnsupportedEnvelopeVersionError(`algorithm ${envelope.alg}`);
  }
}

/** Generates a fresh AES-256-GCM key. Extractable so the sender can export it. */
export async function generateKey(): Promise<WebCryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: KEY_BYTES * 8 },
    true,
    ["encrypt", "decrypt"],
  );
}

/** Exports the raw key as base64url. Never send this to the server. */
export async function exportKey(key: WebCryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  if (raw.length !== KEY_BYTES) {
    throw new EnvelopeFormatError(
      `exported key must be ${KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return toBase64Url(raw);
}

/** Imports a base64url key for decryption only. */
export async function importKey(encoded: string): Promise<WebCryptoKey> {
  const raw = decodeExactly(encoded, "key", KEY_BYTES);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
}

/**
 * Encrypts UTF-8 plaintext. The size limit is enforced on encoded bytes
 * before any cryptographic work happens.
 *
 * The IV is not caller-supplied: every call generates a fresh
 * cryptographically random 96-bit IV.
 */
export async function encrypt(
  plaintext: string,
  key: WebCryptoKey,
): Promise<SecretEnvelope> {
  assertAes256GcmKey(key);
  const encoded = new TextEncoder().encode(plaintext);
  if (encoded.length > MAX_PLAINTEXT_BYTES) {
    throw new PlaintextTooLargeError();
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: TAG_LENGTH_BITS },
      key,
      encoded,
    ),
  );
  return {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    iv: toBase64Url(iv),
    ct: toBase64Url(ciphertext),
  };
}

/** Decrypts an envelope. Any authentication failure yields DecryptionFailedError. */
export async function decrypt(
  envelope: SecretEnvelope,
  key: WebCryptoKey,
): Promise<string> {
  assertSupported(envelope);
  assertAes256GcmKey(key);
  const iv = decodeExactly(envelope.iv, "iv", IV_BYTES);
  // The size limit binds on the receiving side too: an envelope built
  // without this module's encrypt() must not smuggle an oversized payload.
  const ciphertext = decodeCiphertext(envelope.ct, "ct");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: TAG_LENGTH_BITS },
      key,
      ciphertext,
    );
  } catch {
    throw new DecryptionFailedError();
  }
  // Defensive: with a 128-bit tag the ciphertext bound above already implies
  // this, but the limit is a security invariant and is re-checked against
  // what was actually recovered.
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new PlaintextTooLargeError();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new InvalidPlaintextEncodingError();
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
