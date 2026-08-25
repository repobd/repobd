// RepoBD delivery link — the string a sender hands to a receiver.
//
// Shape:
//
//   https://<repobd-host>/d/<secret-id>#k=<key>&b=<binding-json>
//
// This file also owns the one origin policy both ends of that shape are held
// to — see `checkOriginPolicy`. The builder and the parser share it rather than
// each carrying their own checks, because the two diverging is exactly the bug
// where a sender reports success over an origin the receiver then refuses.
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

/** TLS, for every RepoBD service that is not on this machine. */
const TLS_PROTOCOL = "https:";

/** The one scheme the loopback exception below admits, and only there. */
const LOCAL_PROTOCOL = "http:";

/**
 * The hosts a `http:` origin may name, and nothing else.
 *
 * The exception exists for one reason: `wrangler dev` serves the Worker over
 * plain HTTP on this machine, and without it the local development flow could
 * create a delivery it could never pull back. These three spellings are the
 * platform's own loopback forms — the same set browsers treat as a secure
 * context — and they are matched literally. No wider private range, no
 * `.localhost` suffix, no name that merely resolves to a loopback address:
 * resolution happens in the network stack, long after this check, and a host
 * that resolves loopback today is not a host that must.
 *
 * `URL.hostname` lowercases and keeps IPv6 brackets, so these are the exact
 * strings a parsed URL yields.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/** Why an origin is not one RepoBD will address or accept. */
export type OriginPolicyFailureReason = "unsupported-scheme" | "credentials";

/**
 * The scheme and credential policy for every RepoBD origin, in one place.
 *
 * HTTPS is required of any origin that is not local loopback; loopback may be
 * plain HTTP. Embedded userinfo is refused under either scheme — a URL that
 * reads as one host and addresses another is a trick, not a configuration.
 *
 * Returns the reason rather than throwing, so both callers keep their own
 * failure vocabulary.
 */
export function checkOriginPolicy(url: URL): OriginPolicyFailureReason | null {
  const local =
    url.protocol === LOCAL_PROTOCOL && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== TLS_PROTOCOL && !local) {
    return "unsupported-scheme";
  }
  if (url.username !== "" || url.password !== "") {
    return "credentials";
  }
  return null;
}

export type ServiceOriginFailureReason =
  | "not-a-url"
  | OriginPolicyFailureReason
  | "unexpected-path"
  | "unexpected-query"
  | "unexpected-fragment";

export type ServiceOriginResult =
  | { readonly ok: true; readonly origin: string }
  | {
      readonly ok: false;
      readonly reason: ServiceOriginFailureReason;
      /** Non-secret, and never the value that failed. */
      readonly detail: string;
    };

/**
 * Validates a configured RepoBD service origin and returns it normalized.
 *
 * An origin is a scheme, a host and a port — nothing else. A path, a query, or
 * a fragment is refused rather than dropped: silently discarding part of what
 * someone configured is how a request ends up addressed somewhere other than
 * where they meant. The single normalization is the one that cannot mean
 * anything else — `https://host/` and `https://host` are the same origin, so a
 * bare trailing slash is accepted, and `URL.origin` is what comes back.
 */
export function parseServiceOrigin(raw: string): ServiceOriginResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not-a-url", detail: "value is not a URL" };
  }
  const policy = checkOriginPolicy(url);
  if (policy === "unsupported-scheme") {
    return {
      ok: false,
      reason: policy,
      detail: "a RepoBD service is addressed over https, or http on loopback",
    };
  }
  if (policy === "credentials") {
    return {
      ok: false,
      reason: policy,
      detail: "origin embeds credentials",
    };
  }
  if (url.pathname !== "/") {
    return { ok: false, reason: "unexpected-path", detail: "origin has a path" };
  }
  if (url.search !== "") {
    return {
      ok: false,
      reason: "unexpected-query",
      detail: "origin has a query string",
    };
  }
  if (url.hash !== "") {
    return {
      ok: false,
      reason: "unexpected-fragment",
      detail: "origin has a fragment",
    };
  }
  return { ok: true, origin: url.origin };
}

export interface DeliveryLink {
  /** `<scheme>://host[:port]` — the only part a request is addressed to. */
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
 *
 * The origin is held to `parseServiceOrigin` — the same policy
 * `parseDeliveryLink` applies — so a link this returns is a link the receiving
 * side can read. An origin that fails it throws rather than returning a
 * string, because by the time a link is built the origin has already been
 * validated where it was configured; reaching here with a bad one is a defect,
 * not a user error, and it must not become a printed link. The failing value
 * is not in the message.
 */
export function buildDeliveryLink(input: {
  readonly origin: string;
  readonly secretId: string;
  readonly key: string;
  readonly repo: CanonicalRepo;
}): string {
  const origin = parseServiceOrigin(input.origin);
  if (!origin.ok) {
    throw new Error(`delivery link origin is not usable: ${origin.detail}`);
  }
  const fragment = new URLSearchParams();
  fragment.set(KEY_PARAM, input.key);
  fragment.set(BINDING_PARAM, serializeBinding(input.repo));
  return `${origin.origin}/d/${input.secretId}#${fragment.toString()}`;
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

  // The same scheme and credential policy the builder applies: https, or plain
  // http only for a loopback development service. A link is pasted from a chat
  // window, so embedded userinfo — a classic way to make a URL read as one host
  // and address another — is refused under either scheme.
  const policy = checkOriginPolicy(url);
  if (policy === "unsupported-scheme") {
    return fail(policy, "delivery links use https, or http on loopback");
  }
  if (policy === "credentials") {
    return fail(policy, "link embeds credentials");
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
