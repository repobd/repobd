// RepoBD delivery link — the string a sender hands to a receiver.
//
// Shape:
//
//   https://<repobd-host>/d/<secret-id>#k=<key>&b=<binding-json>
//
// Everything the server may see is in front of the `#`; everything the server
// must never see is behind it. A URL fragment is never transmitted by any HTTP
// client, so the decryption key and the repository binding stay on the two
// developers' machines. That split is the whole point of the format, and it is
// why the parsed result separates `origin` and `secretId` — the only values a
// request is ever built from — from `key` and `binding`, which are not.
//
// Deliberately not a URL framework. This parses exactly one shape, refuses
// everything else, and returns a reason rather than throwing, so a caller
// cannot accidentally continue past a link it could not read.
//
// Nothing here logs. The key and the raw fragment are never placed in a
// failure `detail`, never interpolated into a message, and never returned to
// anything but the guard that consumes them.

import { KEY_BYTES, decodeExactly } from "../crypto/envelope-format.js";
import { isCapability } from "./capability.js";
import {
  parseBinding,
  serializeBinding,
  type RepoBinding,
} from "../repo/binding.js";
import type { CanonicalRepo } from "../repo/identity.js";

/** The single path shape a delivery link may use. */
const DELIVERY_PATH_PATTERN = /^\/d\/([^/]+)$/;

/** Fragment parameter names. Short because they are typed and pasted by hand. */
const KEY_PARAM = "k";
const BINDING_PARAM = "b";

/**
 * The complete set of fragment parameters. A delivery fragment carries these
 * two, once each, and nothing else — see `parseFragment`.
 */
const FRAGMENT_PARAMS: ReadonlySet<string> = new Set([KEY_PARAM, BINDING_PARAM]);

/** Only TLS. A delivery link names a hosted RepoBD service, not a local one. */
const REQUIRED_PROTOCOL = "https:";

export interface DeliveryLink {
  /** `https://host[:port]` — the only part a request is addressed to. */
  readonly origin: string;
  /** Opaque server-side capability identifying the stored ciphertext. */
  readonly secretId: string;
  /** base64url AES-256 key. Client-side only. Never logged, never sent. */
  readonly key: string;
  /** The validated binding descriptor. */
  readonly binding: RepoBinding;
  /** The bound repository identity, already canonical. */
  readonly repo: CanonicalRepo;
}

export type LinkParseFailureReason =
  | "not-a-url"
  | "unsupported-scheme"
  | "credentials"
  | "unexpected-query"
  | "not-a-delivery-path"
  | "invalid-secret-id"
  | "missing-fragment"
  | "unknown-fragment-field"
  | "duplicate-fragment-field"
  | "missing-key"
  | "invalid-key"
  | "missing-binding"
  | "malformed-binding"
  | "unsupported-binding-version";

export type LinkParseResult =
  | { readonly ok: true; readonly link: DeliveryLink }
  | {
      readonly ok: false;
      readonly reason: LinkParseFailureReason;
      /** Non-secret. Never contains the key, the fragment, or the URL. */
      readonly detail: string;
    };

function fail(
  reason: LinkParseFailureReason,
  detail: string,
): LinkParseResult {
  return { ok: false, reason, detail };
}

/**
 * Reads the fragment under an exact grammar: exactly one `k`, exactly one
 * `b`, and nothing else.
 *
 * `URLSearchParams` is used to decode, not to decide. Its `get` returns the
 * first value, and first-value-wins is precisely the wrong rule here: a link
 * carrying `b=<mine>&b=<theirs>` would bind to one repository while reading as
 * though it named another, which is an ambiguity a guardrail must refuse
 * rather than resolve. Unknown fields are refused for the same reason — a
 * parameter this version does not understand may be one a later version gives
 * meaning to.
 */
function parseFragment(
  hash: string,
): { readonly key: string; readonly binding: string } | LinkParseResult {
  const entries = [...new URLSearchParams(hash).entries()];
  const seen = new Map<string, string>();
  for (const [name, value] of entries) {
    if (!FRAGMENT_PARAMS.has(name)) {
      return fail("unknown-fragment-field", "fragment has an unknown field");
    }
    if (seen.has(name)) {
      return fail("duplicate-fragment-field", "fragment repeats a field");
    }
    seen.set(name, value);
  }
  const key = seen.get(KEY_PARAM);
  if (key === undefined || key === "") {
    return fail("missing-key", "link carries no decryption key");
  }
  const binding = seen.get(BINDING_PARAM);
  if (binding === undefined || binding === "") {
    return fail("missing-binding", "link carries no repository binding");
  }
  return { key, binding };
}

/**
 * Builds a delivery link.
 *
 * Takes a `CanonicalRepo` rather than a string, so an unresolved or
 * uncanonicalized repository cannot be bound: `serializeBinding` is the only
 * way a descriptor is produced, here as everywhere else.
 */
export function buildDeliveryLink(input: {
  readonly origin: string;
  readonly secretId: string;
  readonly key: string;
  readonly repo: CanonicalRepo;
}): string {
  const fragment = new URLSearchParams();
  fragment.set(KEY_PARAM, input.key);
  fragment.set(BINDING_PARAM, serializeBinding(input.repo));
  return `${input.origin.replace(/\/+$/, "")}/d/${input.secretId}#${fragment.toString()}`;
}

/**
 * Parses and fully validates a delivery link.
 *
 * Fails closed on every deviation, including a *missing* binding: a link with
 * no repository binding is not an unbound delivery, it is a link RepoBD cannot
 * apply its one guarantee to.
 */
export function parseDeliveryLink(raw: string): LinkParseResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return fail("not-a-url", "value is not a URL");
  }

  if (url.protocol !== REQUIRED_PROTOCOL) {
    return fail("unsupported-scheme", "delivery links use https");
  }
  // A link is pasted from a chat window; embedded userinfo is both unexpected
  // and a classic way to make a URL read as one host and address another.
  if (url.username !== "" || url.password !== "") {
    return fail("credentials", "link embeds credentials");
  }
  if (url.search !== "") {
    return fail("unexpected-query", "link has a query string");
  }

  const pathMatch = DELIVERY_PATH_PATTERN.exec(url.pathname);
  if (pathMatch === null) {
    return fail("not-a-delivery-path", "link is not a delivery path");
  }
  // The captured segment is checked in the form it was written — `URL` leaves
  // percent-escapes in `pathname` — against the Worker's own capability
  // grammar. A dot segment, an encoded slash, wrong length, or `=` padding is
  // therefore refused locally, before any request could be addressed with it.
  const secretId = pathMatch[1] as string;
  if (!isCapability(secretId)) {
    return fail("invalid-secret-id", "secret id is not a canonical capability");
  }

  // `url.hash` is "" both when there is no `#` and when the fragment is empty.
  // Either way there is no key and no binding, which is the same block.
  if (url.hash === "") {
    return fail("missing-fragment", "link has no fragment");
  }
  const fragment = parseFragment(url.hash.slice(1));
  if ("ok" in fragment) {
    return fragment;
  }

  const { key } = fragment;
  try {
    // Validated, then discarded. The decoded bytes are not retained here, and
    // the encoded key never reaches a message: `decodeExactly` reports only
    // the field name and the expected size.
    decodeExactly(key, "key", KEY_BYTES);
  } catch {
    return fail("invalid-key", "decryption key is not a valid AES-256 key");
  }

  const binding = parseBinding(fragment.binding);
  if (!binding.ok) {
    // A binding that is present but unreadable is never treated as absent,
    // and never skipped: it blocks with its own reason.
    if (binding.reason === "unsupported-version") {
      return fail("unsupported-binding-version", binding.detail);
    }
    return fail("malformed-binding", binding.detail);
  }

  return {
    ok: true,
    link: {
      origin: url.origin,
      secretId,
      key,
      binding: binding.binding,
      repo: binding.repo,
    },
  };
}
