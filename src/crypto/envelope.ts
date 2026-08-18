// RepoBD crypto envelope — Phase 1, local-only proof.
//
// Uses only native Web Crypto and browser-compatible globals, so the same
// module can serve both the CLI (decrypt) and the web sender (encrypt). The
// RepoBD server never runs this module: it never receives the key or the
// plaintext. See docs/SECURITY_INVARIANTS.md.
//
// The wire format itself lives in `envelope-format.ts`, which carries no
// cryptographic runtime — that is what the Worker validates against, so
// validating an envelope server-side never brings decryption with it.
//
// Nothing here logs, prints, or embeds plaintext or key material — including
// in error messages.

import {
  ENVELOPE_ALG,
  ENVELOPE_VERSION,
  EnvelopeFormatError,
  IV_BYTES,
  KEY_BYTES,
  MAX_PLAINTEXT_BYTES,
  PlaintextTooLargeError,
  TAG_LENGTH_BITS,
  assertSupported,
  decodeCiphertext,
  decodeExactly,
  toBase64Url,
  type SecretEnvelope,
} from "./envelope-format.js";

// The envelope format is part of this module's public surface: callers work
// with envelopes and their errors alongside encrypt/decrypt.
export {
  ENVELOPE_ALG,
  ENVELOPE_VERSION,
  EnvelopeFormatError,
  MAX_PLAINTEXT_BYTES,
  PlaintextTooLargeError,
  UnsupportedEnvelopeVersionError,
  parseEnvelope,
  serializeEnvelope,
  type SecretEnvelope,
} from "./envelope-format.js";

/**
 * `CryptoKey` is not a global type under every runtime's TypeScript setup —
 * Node exposes it only through `node:crypto`. Deriving it from the ambient
 * Web Crypto implementation keeps this module free of runtime-specific
 * imports and lets the same source typecheck for Node and the browser.
 */
export type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

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
