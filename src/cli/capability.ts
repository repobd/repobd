// Bearer capability format, client side.
//
// INVARIANT: this must stay identical to `CAPABILITY_BYTES` / `isCapability`
// in `src/worker/validate.ts` — 128 bits, canonical base64url, exactly 22
// characters, no padding.
//
// It is restated here rather than imported. `src/worker/validate.ts` is
// compiled against the Workers type environment (`Request`, `D1Database`) and
// pulling it into the CLI program would drag the server's type surface into
// the client build. What is duplicated is a size and a call to the *same*
// strict decoder both sides use, not a second parsing implementation, so the
// two cannot disagree about what a canonical token is — only, conceivably,
// about its length, which the tests pin.
//
// Both directions matter: a secret id RepoBD accepts locally must be one the
// Worker would accept, and a claim token RepoBD mints must be one the Worker
// will not reject.

import {
  EnvelopeFormatError,
  base64UrlLength,
  decodeExactly,
  toBase64Url,
} from "../crypto/envelope-format.js";

/** Bytes of randomness behind a secret id or a claim token. */
export const CAPABILITY_BYTES = 16;

/** Exact character length of an encoded capability. 128 bits -> 22. */
export const CAPABILITY_CHARS = base64UrlLength(CAPABILITY_BYTES);

/**
 * True when `value` is a canonical, exactly-sized base64url capability.
 *
 * Delegates to the envelope format's strict decoder — the same one the Worker
 * uses — so a wrong length, a non-alphabet character, `=` padding, and a
 * non-canonical trailing-bit encoding are all rejected by one implementation.
 */
export function isCapability(value: string): boolean {
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

/** Generates a fresh 128-bit capability. */
export function generateCapability(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(CAPABILITY_BYTES)));
}
