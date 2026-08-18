import { describe, expect, it, vi } from "vitest";
import {
  DecryptionFailedError,
  EnvelopeFormatError,
  ENVELOPE_ALG,
  ENVELOPE_VERSION,
  InvalidPlaintextEncodingError,
  MAX_PLAINTEXT_BYTES,
  PlaintextTooLargeError,
  UnsupportedEnvelopeVersionError,
  UnsupportedKeyError,
  decrypt,
  encrypt,
  exportKey,
  generateKey,
  importKey,
  parseEnvelope,
  serializeEnvelope,
  type SecretEnvelope,
  type WebCryptoKey,
} from "../src/crypto/envelope.js";

// Dummy value only. Never a real credential, and never printed.
const DUMMY_SECRET = "API_KEY=TEST_ALPHA_123456";

const KEY_BYTES = 32;
const IV_BYTES = 12;

// Deliberately independent of the module's own helpers so the tests do not
// validate a helper against itself.
function decodeBase64Url(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function flipFirstByte(encoded: string): string {
  const bytes = decodeBase64Url(encoded);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return encodeBase64Url(bytes);
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Rewrites the final base64url character to a different one that decodes to
 * the same bytes, i.e. one that differs only in the unused trailing bits.
 * Returns undefined when the encoding has no spare trailing bits.
 */
function withNonZeroTrailingBits(encoded: string): string | undefined {
  if (encoded.length % 4 === 0) {
    return undefined; // whole bytes; no unused bits to flip
  }
  const last = encoded.at(-1);
  if (last === undefined) {
    return undefined;
  }
  const index = BASE64URL_ALPHABET.indexOf(last);
  const mutated = (index & ~3) | (((index & 3) + 1) % 4);
  return encoded.slice(0, -1) + BASE64URL_ALPHABET[mutated];
}

/**
 * Builds an envelope without using this module's encrypt(), so tests can
 * present input a hostile or non-RepoBD sender could produce.
 */
async function forgeEnvelope(
  key: WebCryptoKey,
  payload: Uint8Array,
): Promise<SecretEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      payload,
    ),
  );
  return {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    iv: encodeBase64Url(iv),
    ct: encodeBase64Url(ciphertext),
  };
}

/**
 * Runs a call that must reject, recording the length of every string handed
 * to `atob`. Lets a test assert that oversized input was turned away before
 * the expensive decode rather than after it — without that assertion the
 * decoded-size check would throw the same error and the test would pass
 * even if the encoded-length precheck were deleted.
 */
async function decodeLengthsDuring(
  run: () => Promise<unknown>,
): Promise<{ error: Error; decodedLengths: number[] }> {
  const spy = vi.spyOn(globalThis, "atob");
  try {
    const error = await rejectionOf(run());
    return {
      error,
      decodedLengths: spy.mock.calls.map(([value]) => value.length),
    };
  } finally {
    spy.mockRestore();
  }
}

/** Awaits a promise that must reject and returns the rejection reason. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    caught = error;
    rejected = true;
  }
  expect(rejected).toBe(true);
  return caught as Error;
}

describe("round trip", () => {
  it("decrypts what it encrypted", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    expect(await decrypt(envelope, key)).toBe(DUMMY_SECRET);
  });

  it("preserves multi-byte characters", async () => {
    const plaintext = "TOKEN=テスト🔑値";
    const key = await generateKey();
    const envelope = await encrypt(plaintext, key);
    expect(await decrypt(envelope, key)).toBe(plaintext);
  });

  it("round trips through serialization and an exported key", async () => {
    const senderKey = await generateKey();
    const wireEnvelope = serializeEnvelope(await encrypt(DUMMY_SECRET, senderKey));
    const wireKey = await exportKey(senderKey);

    const receiverKey = await importKey(wireKey);
    expect(await decrypt(parseEnvelope(wireEnvelope), receiverKey)).toBe(
      DUMMY_SECRET,
    );
  });

  it("accepts a plaintext of exactly the maximum size", async () => {
    const key = await generateKey();
    const plaintext = "a".repeat(MAX_PLAINTEXT_BYTES);
    expect(await decrypt(await encrypt(plaintext, key), key)).toBe(plaintext);
  });
});

describe("serialization boundary", () => {
  it("exports a key of exactly 32 bytes", async () => {
    const encoded = await exportKey(await generateKey());
    expect(decodeBase64Url(encoded)).toHaveLength(KEY_BYTES);
  });

  it("emits an IV of exactly 12 bytes", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    expect(decodeBase64Url(envelope.iv)).toHaveLength(IV_BYTES);
  });

  it("emits the declared version and algorithm", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    expect(envelope.v).toBe(ENVELOPE_VERSION);
    expect(envelope.alg).toBe(ENVELOPE_ALG);
  });

  it("carries no key material or plaintext in the envelope", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const serialized = serializeEnvelope(envelope);
    expect(serialized).not.toContain(DUMMY_SECRET);
    expect(serialized).not.toContain(await exportKey(key));
    expect(Object.keys(envelope).sort()).toEqual(["alg", "ct", "iv", "v"]);
  });
});

describe("payload size limit", () => {
  it("rejects a plaintext one byte over the maximum", async () => {
    const key = await generateKey();
    await expect(
      encrypt("a".repeat(MAX_PLAINTEXT_BYTES + 1), key),
    ).rejects.toBeInstanceOf(PlaintextTooLargeError);
  });

  it("measures encoded bytes, not character count", async () => {
    // 30000 characters — well under the limit by character count — but
    // 90000 bytes once encoded as UTF-8.
    const plaintext = "あ".repeat(30000);
    expect(plaintext.length).toBeLessThan(MAX_PLAINTEXT_BYTES);
    expect(new TextEncoder().encode(plaintext).length).toBeGreaterThan(
      MAX_PLAINTEXT_BYTES,
    );
    await expect(
      encrypt(plaintext, await generateKey()),
    ).rejects.toBeInstanceOf(PlaintextTooLargeError);
  });
});

describe("authentication failures", () => {
  it("rejects tampered ciphertext", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const tampered: SecretEnvelope = { ...envelope, ct: flipFirstByte(envelope.ct) };
    await expect(decrypt(tampered, key)).rejects.toBeInstanceOf(
      DecryptionFailedError,
    );
  });

  it("rejects a tampered IV", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const tampered: SecretEnvelope = { ...envelope, iv: flipFirstByte(envelope.iv) };
    await expect(decrypt(tampered, key)).rejects.toBeInstanceOf(
      DecryptionFailedError,
    );
  });

  it("rejects the wrong key", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    await expect(decrypt(envelope, await generateKey())).rejects.toBeInstanceOf(
      DecryptionFailedError,
    );
  });

  it("does not distinguish a wrong key from tampering", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const wrongKeyError = await rejectionOf(
      decrypt(envelope, await generateKey()),
    );
    const tamperedError = await rejectionOf(
      decrypt({ ...envelope, ct: flipFirstByte(envelope.ct) }, key),
    );

    expect(wrongKeyError.name).toBe(tamperedError.name);
    expect(wrongKeyError.message).toBe(tamperedError.message);
  });
});

describe("envelope validation", () => {
  it("rejects input that is not JSON", () => {
    expect(() => parseEnvelope("not json")).toThrow(EnvelopeFormatError);
  });

  it("rejects JSON that is not an object", () => {
    expect(() => parseEnvelope('"a string"')).toThrow(EnvelopeFormatError);
    expect(() => parseEnvelope("[]")).toThrow(EnvelopeFormatError);
    expect(() => parseEnvelope("null")).toThrow(EnvelopeFormatError);
  });

  it("rejects a missing field", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    const { ct: _omitted, ...withoutCiphertext } = envelope;
    expect(() => parseEnvelope(JSON.stringify(withoutCiphertext))).toThrow(
      EnvelopeFormatError,
    );
  });

  it("rejects a non-base64url field", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    expect(() =>
      parseEnvelope(serializeEnvelope({ ...envelope, ct: "not base64url!" })),
    ).toThrow(EnvelopeFormatError);
  });

  it("rejects padded base64", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    expect(() =>
      parseEnvelope(serializeEnvelope({ ...envelope, iv: `${envelope.iv}==` })),
    ).toThrow(EnvelopeFormatError);
  });

  it("rejects an IV that is not 12 bytes", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    const shortIv = encodeBase64Url(decodeBase64Url(envelope.iv).slice(0, 8));
    expect(() =>
      parseEnvelope(serializeEnvelope({ ...envelope, iv: shortIv })),
    ).toThrow(EnvelopeFormatError);
  });

  it("rejects a key that is not 32 bytes", async () => {
    const encoded = await exportKey(await generateKey());
    const shortKey = encodeBase64Url(decodeBase64Url(encoded).slice(0, 16));
    await expect(importKey(shortKey)).rejects.toBeInstanceOf(EnvelopeFormatError);
  });

  it("rejects an unsupported version", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    expect(() =>
      parseEnvelope(serializeEnvelope({ ...envelope, v: 999 })),
    ).toThrow(UnsupportedEnvelopeVersionError);
  });

  it("rejects an unsupported algorithm", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    expect(() =>
      parseEnvelope(serializeEnvelope({ ...envelope, alg: "A128GCM" })),
    ).toThrow(UnsupportedEnvelopeVersionError);
  });

  it("rejects an unsupported version at decrypt time", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    await expect(
      decrypt({ ...envelope, v: 999 }, key),
    ).rejects.toBeInstanceOf(UnsupportedEnvelopeVersionError);
  });
});

describe("IV generation", () => {
  it("uses a fresh IV and produces different ciphertext for each encryption", async () => {
    const key = await generateKey();
    const first = await encrypt(DUMMY_SECRET, key);
    const second = await encrypt(DUMMY_SECRET, key);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });

  it("does not repeat an IV across many encryptions", async () => {
    const key = await generateKey();
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      seen.add((await encrypt(DUMMY_SECRET, key)).iv);
    }
    expect(seen.size).toBe(64);
  });
});

describe("key strength", () => {
  it.each([128, 192])("rejects an AES-%i-GCM key when encrypting", async (bits) => {
    const weakKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: bits },
      true,
      ["encrypt", "decrypt"],
    );
    await expect(encrypt(DUMMY_SECRET, weakKey)).rejects.toBeInstanceOf(
      UnsupportedKeyError,
    );
  });

  it.each([128, 192])("rejects an AES-%i-GCM key when decrypting", async (bits) => {
    const weakKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: bits },
      true,
      ["encrypt", "decrypt"],
    );
    const envelope = await forgeEnvelope(
      weakKey,
      new TextEncoder().encode(DUMMY_SECRET),
    );
    await expect(decrypt(envelope, weakKey)).rejects.toBeInstanceOf(
      UnsupportedKeyError,
    );
  });

  // These fixtures are 256-bit on purpose: a non-AES-GCM key that happened
  // to report a different length would pass through the length branch, so
  // the test would still succeed if the algorithm-name check were deleted.
  const nonAesGcmKeys: ReadonlyArray<[string, () => Promise<WebCryptoKey>]> = [
    [
      "AES-CBC-256",
      () =>
        crypto.subtle.generateKey({ name: "AES-CBC", length: 256 }, true, [
          "encrypt",
          "decrypt",
        ]),
    ],
    [
      "HMAC-SHA-256 (256-bit)",
      () =>
        crypto.subtle.generateKey(
          { name: "HMAC", hash: "SHA-256", length: 256 },
          true,
          ["sign", "verify"],
        ),
    ],
  ];

  it.each(nonAesGcmKeys)(
    "reports %s as a 256-bit non-AES-GCM key",
    async (_label, create) => {
      const algorithm = (await create()).algorithm as {
        name: string;
        length: number;
      };
      expect(algorithm.name).not.toBe("AES-GCM");
      expect(algorithm.length).toBe(256);
    },
  );

  it.each(nonAesGcmKeys)(
    "rejects a %s key when encrypting",
    async (_label, create) => {
      await expect(encrypt(DUMMY_SECRET, await create())).rejects.toBeInstanceOf(
        UnsupportedKeyError,
      );
    },
  );

  it.each(nonAesGcmKeys)(
    "rejects a %s key when decrypting",
    async (_label, create) => {
      const envelope = await encrypt(DUMMY_SECRET, await generateKey());
      await expect(decrypt(envelope, await create())).rejects.toBeInstanceOf(
        UnsupportedKeyError,
      );
    },
  );

  it("still accepts generated and imported keys", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const imported = await importKey(await exportKey(key));
    expect(await decrypt(envelope, imported)).toBe(DUMMY_SECRET);
  });
});

describe("serialization projection", () => {
  it("does not serialize extra enumerable properties", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const encodedKey = await exportKey(key);

    const serialized = serializeEnvelope({
      ...envelope,
      key: encodedKey,
      plaintext: DUMMY_SECRET,
    } as SecretEnvelope);

    expect(serialized).not.toContain(encodedKey);
    expect(serialized).not.toContain(DUMMY_SECRET);
    expect(Object.keys(JSON.parse(serialized) as object).sort()).toEqual([
      "alg",
      "ct",
      "iv",
      "v",
    ]);
  });

  it("still round trips a projected envelope", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const reparsed = parseEnvelope(
      serializeEnvelope({ ...envelope, extra: "ignored" } as SecretEnvelope),
    );
    expect(await decrypt(reparsed, key)).toBe(DUMMY_SECRET);
  });
});

describe("payload limit on the decrypt path", () => {
  it("rejects an externally built envelope carrying an oversized payload", async () => {
    const key = await generateKey();
    const envelope = await forgeEnvelope(
      key,
      new TextEncoder().encode("a".repeat(MAX_PLAINTEXT_BYTES + 1)),
    );
    await expect(decrypt(envelope, key)).rejects.toBeInstanceOf(
      PlaintextTooLargeError,
    );
  });

  it("still accepts an externally built envelope at exactly the maximum", async () => {
    const key = await generateKey();
    const plaintext = "a".repeat(MAX_PLAINTEXT_BYTES);
    const envelope = await forgeEnvelope(
      key,
      new TextEncoder().encode(plaintext),
    );
    expect(await decrypt(envelope, key)).toBe(plaintext);
  });

  it("keeps plaintext out of the oversized-decrypt error", async () => {
    const key = await generateKey();
    const envelope = await forgeEnvelope(
      key,
      new TextEncoder().encode(`${DUMMY_SECRET}${"a".repeat(MAX_PLAINTEXT_BYTES)}`),
    );
    const error = await rejectionOf(decrypt(envelope, key));
    expect(error.message).not.toContain(DUMMY_SECRET);
  });
});

describe("encoded-input bounds", () => {
  const GROSSLY_OVERSIZED = "A".repeat(1_000_000);

  // A 12-byte IV encodes to 16 characters; that is the only legitimate
  // decode any of these rejection paths should perform.
  const IV_ENCODED_LENGTH = 16;

  it("rejects a grossly oversized encoded key without decoding it", async () => {
    const { error, decodedLengths } = await decodeLengthsDuring(() =>
      importKey(GROSSLY_OVERSIZED),
    );
    expect(error).toBeInstanceOf(EnvelopeFormatError);
    expect(decodedLengths).toEqual([]);
  });

  it("rejects a grossly oversized encoded IV without decoding it", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    const { error, decodedLengths } = await decodeLengthsDuring(async () =>
      parseEnvelope(serializeEnvelope({ ...envelope, iv: GROSSLY_OVERSIZED })),
    );
    expect(error).toBeInstanceOf(EnvelopeFormatError);
    expect(decodedLengths).toEqual([]);
  });

  it("rejects a grossly oversized ciphertext when parsing, without decoding it", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    const { error, decodedLengths } = await decodeLengthsDuring(async () =>
      parseEnvelope(serializeEnvelope({ ...envelope, ct: GROSSLY_OVERSIZED })),
    );
    expect(error).toBeInstanceOf(PlaintextTooLargeError);
    // Only the valid IV was decoded; the oversized ciphertext never was.
    expect(decodedLengths).toEqual([IV_ENCODED_LENGTH]);
  });

  it("rejects a grossly oversized ciphertext when decrypting, without decoding it", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const { error, decodedLengths } = await decodeLengthsDuring(() =>
      decrypt({ ...envelope, ct: GROSSLY_OVERSIZED }, key),
    );
    expect(error).toBeInstanceOf(PlaintextTooLargeError);
    expect(decodedLengths).toEqual([IV_ENCODED_LENGTH]);
  });

  it("accepts a ciphertext encoding at exactly the maximum length", async () => {
    // 65,536 plaintext bytes + 16-byte tag = 65,552 bytes = 87,403 characters.
    const key = await generateKey();
    const plaintext = "a".repeat(MAX_PLAINTEXT_BYTES);
    const envelope = await forgeEnvelope(
      key,
      new TextEncoder().encode(plaintext),
    );
    expect(envelope.ct).toHaveLength(87403);
    expect(await decrypt(envelope, key)).toBe(plaintext);
  });

  it("keeps secrets out of the oversized-encoding errors", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const error = await rejectionOf(
      decrypt({ ...envelope, ct: GROSSLY_OVERSIZED }, key),
    );
    expect(error.message).not.toContain(DUMMY_SECRET);
    expect(error.message).not.toContain(await exportKey(key));
  });
});

describe("plaintext encoding", () => {
  it("fails closed on authenticated invalid UTF-8", async () => {
    const key = await generateKey();
    const envelope = await forgeEnvelope(key, new Uint8Array([0xff]));
    await expect(decrypt(envelope, key)).rejects.toBeInstanceOf(
      InvalidPlaintextEncodingError,
    );
  });

  it("reveals no payload bytes in the encoding error", async () => {
    const key = await generateKey();
    const envelope = await forgeEnvelope(key, new Uint8Array([0xff, 0xfe]));
    const error = await rejectionOf(decrypt(envelope, key));
    expect(error).toBeInstanceOf(InvalidPlaintextEncodingError);
    expect(error.message).toBe("decrypted payload is not valid UTF-8");
  });
});

describe("canonical base64url", () => {
  it("rejects a key encoding with non-zero unused trailing bits", async () => {
    const encoded = await exportKey(await generateKey());
    const mutated = withNonZeroTrailingBits(encoded);
    expect(mutated).toBeDefined();
    expect(mutated).not.toBe(encoded);
    // Same decoded bytes, different trailing bits.
    expect(decodeBase64Url(mutated as string)).toEqual(decodeBase64Url(encoded));
    await expect(importKey(mutated as string)).rejects.toBeInstanceOf(
      EnvelopeFormatError,
    );
  });

  it("rejects a ciphertext encoding with non-zero unused trailing bits", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    const mutated = withNonZeroTrailingBits(envelope.ct);
    expect(mutated).toBeDefined();
    expect(decodeBase64Url(mutated as string)).toEqual(
      decodeBase64Url(envelope.ct),
    );
    expect(() =>
      parseEnvelope(serializeEnvelope({ ...envelope, ct: mutated as string })),
    ).toThrow(EnvelopeFormatError);
  });

  it("has no trailing-bit slack in a 12-byte IV encoding", async () => {
    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    // 12 bytes encode to exactly 16 characters, so there are no unused bits
    // to smuggle a non-canonical variant into.
    expect(envelope.iv).toHaveLength(16);
    expect(withNonZeroTrailingBits(envelope.iv)).toBeUndefined();
  });

  it("rejects an impossible base64url length", async () => {
    await expect(importKey("AAAAA")).rejects.toBeInstanceOf(EnvelopeFormatError);

    const envelope = await encrypt(DUMMY_SECRET, await generateKey());
    let impossible = envelope.ct;
    while (impossible.length % 4 !== 1) {
      impossible += "A";
    }
    expect(impossible.length % 4).toBe(1);
    expect(() =>
      parseEnvelope(serializeEnvelope({ ...envelope, ct: impossible })),
    ).toThrow(EnvelopeFormatError);
  });
});

describe("error hygiene", () => {
  it("keeps plaintext out of the oversized-payload error", async () => {
    const oversized = `${DUMMY_SECRET}${"a".repeat(MAX_PLAINTEXT_BYTES)}`;
    const error = await rejectionOf(encrypt(oversized, await generateKey()));
    expect(error).toBeInstanceOf(PlaintextTooLargeError);
    expect(error.message).not.toContain(DUMMY_SECRET);
  });

  it("keeps plaintext and key material out of the decryption error", async () => {
    const key = await generateKey();
    const envelope = await encrypt(DUMMY_SECRET, key);
    const error = await rejectionOf(decrypt(envelope, await generateKey()));
    expect(error).toBeInstanceOf(DecryptionFailedError);
    expect(error.message).not.toContain(DUMMY_SECRET);
    expect(error.message).not.toContain(await exportKey(key));
    expect(error.message).not.toContain(envelope.ct);
  });
});
