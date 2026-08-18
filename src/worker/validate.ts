// Input validation for the Worker API. Nothing here decrypts, and no
// decryption key ever reaches this layer — see docs/SECURITY_INVARIANTS.md.
//
// base64url and envelope-size rules come from `envelope-format.ts`, which is
// their single source of truth. They are not restated here.

import {
  EnvelopeFormatError,
  IV_BYTES,
  MAX_CIPHERTEXT_BYTES,
  base64UrlLength,
  decodeExactly,
  toBase64Url,
} from "../crypto/envelope-format.js";

/** Bytes of randomness behind a secret id or a claim token. */
export const CAPABILITY_BYTES = 16; // 128 bits

/** Exact length of a base64url capability string. 128 bits -> 22 characters. */
export const CAPABILITY_CHARS = base64UrlLength(CAPABILITY_BYTES);

// Derived from the envelope format, not chosen independently: the ciphertext
// is base64url-encoded into the envelope JSON, which is then wrapped again as
// a JSON string in the request body. The slack covers whitespace and key
// ordering in the caller's formatting.
const MAX_ENVELOPE_CHARS = JSON.stringify({
  v: 1,
  alg: "A256GCM",
  iv: "x".repeat(base64UrlLength(IV_BYTES)),
  ct: "x".repeat(base64UrlLength(MAX_CIPHERTEXT_BYTES)),
}).length;
const REQUEST_FORMATTING_SLACK = 1024;
export const MAX_REQUEST_BODY_BYTES =
  JSON.stringify({
    envelope: "x".repeat(MAX_ENVELOPE_CHARS),
    ttl_seconds: 86400,
  }).length + REQUEST_FORMATTING_SLACK;

/** Maximum accepted TTL: 24 hours, in seconds. */
export const MAX_TTL_SECONDS = 86_400;

/** Generates a 128-bit base64url bearer capability. */
export function generateCapability(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(CAPABILITY_BYTES)));
}

/**
 * True when `value` is a canonical, exactly-sized base64url capability.
 * Delegates to the envelope format's strict decoder, so wrong lengths,
 * non-alphabet characters, padding, and non-canonical trailing bits are all
 * rejected by the same implementation the envelope itself uses.
 */
export function isCapability(value: unknown): value is string {
  try {
    decodeExactly(value, "capability", CAPABILITY_BYTES);
    return true;
  } catch (error) {
    if (error instanceof EnvelopeFormatError) {
      return false;
    }
    throw error;
  }
}

/** True when `value` is a positive integer TTL within the allowed maximum. */
export function isTtlSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_TTL_SECONDS
  );
}

/**
 * Reads the request body as text, refusing anything over `maxBytes` before it
 * is buffered rather than parsing first and checking afterwards. Returns null
 * when the body is too large or is not valid UTF-8.
 */
export async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length > maxBytes) {
      return null;
    }
  }

  const body = request.body;
  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      merged,
    );
  } catch {
    return null;
  }
}
