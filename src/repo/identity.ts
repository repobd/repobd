// RepoBD canonical repository identity — the rule that decides whether two
// remote URLs name the same repository.
//
// SCOPE, deliberately narrow. This is **not** a general Git remote parser, and
// it should not be read as an incomplete one. RepoBD v0.1 supports common
// hosted repositories on GitHub.com, GitLab.com, and Bitbucket Cloud. Every
// other Git remote semantic — self-hosted servers, arbitrary SSH targets,
// `git://`, plain HTTP, non-default ports, host aliases — fails closed as
// unsupported. That is a product decision, not a gap waiting to be filled:
// modelling all of Git's transport semantics correctly is a much larger
// problem than the accident RepoBD exists to prevent, and getting it subtly
// wrong is precisely how a secret reaches the wrong repository.
//
// The canonical form is a **hosted repository locator**:
//
//   <lowercase-host>/<case-preserved-path>
//
// It says nothing about transport. Treating the supported HTTPS and SSH
// spellings of one hosted repository as equal is a RepoBD convention about
// these three providers — not a claim that HTTPS and SSH targets are
// equivalent in general.
//
// Deliberately free of any I/O: no `node:child_process`, no filesystem, no
// network, no DNS, no Git invocation, no provider API, no repository-ID
// lookup. Everything here is a pure function of its argument.
//
// Comparison is exact and case-sensitive. Nothing does partial, suffix, alias,
// or fuzzy matching: a false positive means a secret reaches the wrong
// repository, so anything that cannot be resolved without guessing is
// rejected rather than approximated.
//
// The parsing is written out explicitly rather than delegating to `URL`.
// `URL` applies WHATWG canonicalization that is wrong here: it silently
// transforms non-ASCII hosts (IDN) instead of refusing them, and it
// percent-decodes. RepoBD's identity rules are a security decision and must
// not shift with a host runtime's URL semantics.

/**
 * The hosted providers RepoBD v0.1 supports. Kept as a flat list on purpose:
 * a provider abstraction, plugin surface, or profile registry is not needed
 * for three entries, and support is meant to grow from demonstrated demand.
 */
export const SUPPORTED_HOSTS = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
] as const;

const SUPPORTED_HOST_SET: ReadonlySet<string> = new Set(SUPPORTED_HOSTS);

/**
 * The SSH account these providers use. A remote naming any other user is not
 * a hosted-provider remote — it is an arbitrary SSH target, which v0.1 does
 * not model.
 */
const PROVIDER_SSH_USER = "git";

/**
 * Ports that may appear written out. Only a scheme's own default is tolerated,
 * and it is discarded; a non-default port means a host that is not one of the
 * supported providers' public endpoints.
 */
const ALLOWED_EXPLICIT_PORTS = new Map<string, string>([
  ["https", "443"],
  ["ssh", "22"],
]);

const MAX_HOST_LENGTH = 253;

const SCHEME_PREFIX_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;

const GIT_SUFFIX = ".git";

/**
 * The smallest path a hosted repository can have: an owner or workspace, then
 * a repository. Deeper paths are kept as-is so GitLab's nested groups survive
 * — RepoBD does not impose a per-provider depth, because the remote string is
 * the source of truth and no API is consulted to second-guess it.
 */
const MIN_PATH_SEGMENTS = 2;

export interface CanonicalRepo {
  /** `<host>/<path>` — the only value that is ever compared. */
  readonly canonical: string;
  /** Lowercased, and always one of `SUPPORTED_HOSTS`. */
  readonly host: string;
  /** Case preserved. Hosted repository paths are not case-insensitive. */
  readonly path: string;
}

export type CanonicalizeFailureReason =
  | "empty"
  | "non-ascii"
  | "local-path"
  | "windows-path"
  | "query-or-fragment"
  | "credentials"
  | "unsupported-scheme"
  | "unsupported-host"
  | "unsupported-port"
  | "unsupported-ssh-user"
  | "ambiguous-userinfo"
  | "ambiguous-git-suffix"
  | "invalid-path"
  | "malformed";

export type CanonicalizeResult =
  | { readonly ok: true; readonly repo: CanonicalRepo }
  | {
      readonly ok: false;
      readonly reason: CanonicalizeFailureReason;
      readonly detail: string;
    };

// Failures are returned rather than thrown because "cannot canonicalize" is a
// normal, expected decision that must end in a block. A returned result cannot
// be swallowed by an unrelated `catch`, and the reason code is what the
// receiver-side message is built from later.
function fail(
  reason: CanonicalizeFailureReason,
  detail: string,
): CanonicalizeResult {
  return { ok: false, reason, detail };
}

/** Printable ASCII only. Non-ASCII hosts introduce IDN homograph and Unicode
 * normalization ambiguity, and control characters or embedded whitespace mean
 * the input is not a remote URL at all. */
function isPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

/**
 * Splits `[userinfo@]rest`, returning the userinfo separately so no caller can
 * accidentally fold it into an identity.
 */
interface Authority {
  readonly userinfo: string | null;
  readonly hostPort: string;
}

function splitAuthority(authority: string): Authority | CanonicalizeResult {
  const at = authority.indexOf("@");
  if (at === -1) {
    return { userinfo: null, hostPort: authority };
  }
  if (authority.indexOf("@", at + 1) !== -1) {
    return fail("ambiguous-userinfo", "authority has multiple @ separators");
  }
  return {
    userinfo: authority.slice(0, at),
    hostPort: authority.slice(at + 1),
  };
}

/**
 * Accepts `<supported-host>` or `<supported-host>:<scheme-default-port>`.
 *
 * The host allowlist is what makes this safe without a hostname-shape rule:
 * there is no need to guess whether a dotless name is a host or a Windows
 * drive letter when the only acceptable answers are three known strings.
 */
function parseHostPort(
  hostPort: string,
  scheme: string,
): string | CanonicalizeResult {
  if (hostPort.length > MAX_HOST_LENGTH) {
    return fail("unsupported-host", "host is too long");
  }
  const colon = hostPort.indexOf(":");
  let rawHost = hostPort;
  if (colon !== -1) {
    if (hostPort.indexOf(":", colon + 1) !== -1) {
      return fail("malformed", "authority has multiple port separators");
    }
    const port = hostPort.slice(colon + 1);
    // A non-default port cannot be one of these providers' public endpoints,
    // so it is refused instead of being carried into the identity.
    if (port !== ALLOWED_EXPLICIT_PORTS.get(scheme)) {
      return fail("unsupported-port", "remote specifies a non-default port");
    }
    rawHost = hostPort.slice(0, colon);
  }
  // DNS is case-insensitive, so folding case cannot merge two hosts.
  const host = rawHost.toLowerCase();
  if (!SUPPORTED_HOST_SET.has(host)) {
    // Covers self-hosted servers and provider aliases such as
    // `ssh.github.com`, which is a different endpoint and not normalized here.
    return fail("unsupported-host", "host is not a supported provider");
  }
  return host;
}

/**
 * Splits and validates a repository path. Shared by both grammars, because
 * what counts as a well-formed repository path is one rule.
 *
 * Note what this does *not* do: it never touches the `.git` suffix. Suffix
 * removal belongs to the remote parser alone — see `stripGitSuffix`.
 */
function splitAndValidateSegments(
  rawPath: string,
): string[] | CanonicalizeResult {
  // Splitting on `/` and dropping empty segments absorbs leading, trailing,
  // and repeated slashes in one step.
  const segments = rawPath.split("/").filter((segment) => segment !== "");
  if (segments.length < MIN_PATH_SEGMENTS) {
    return fail("invalid-path", "path does not name an owner and a repository");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      return fail("invalid-path", "path contains a relative segment");
    }
    if (!PATH_SEGMENT_PATTERN.test(segment)) {
      return fail("invalid-path", "path segment has an invalid character");
    }
  }
  if (segments[segments.length - 1] === GIT_SUFFIX) {
    // `owner/repo/.git` is not `owner/repo` with a suffix — collapsing it
    // would invent a parent repository the URL never named.
    return fail("ambiguous-git-suffix", "path ends with a bare .git component");
  }
  return segments;
}

/**
 * Removes the clone-URL `.git` presentation suffix.
 *
 * This is a convention of these three providers' clone URLs, not a general
 * Git rule, and it is applied **only** when canonicalizing a remote — never
 * when reading a value that is already canonical. The difference matters: a
 * repository genuinely named `repo.git` is cloned from `.../repo.git.git`, so
 * its canonical identity is `owner/repo.git`. Stripping again on the way back
 * in would refuse that identity as non-canonical and block a correct
 * delivery.
 *
 * Total by construction: a bare `.git` final component is already rejected
 * above, so the slice below can never empty the segment.
 */
function stripGitSuffix(segments: string[]): string[] {
  const last = segments[segments.length - 1];
  if (last === undefined || !last.endsWith(GIT_SUFFIX)) {
    return segments;
  }
  // Stripped exactly once, so `repo.git.git` canonicalizes to `repo.git`.
  return [...segments.slice(0, -1), last.slice(0, -GIT_SUFFIX.length)];
}

function build(host: string, path: string): CanonicalRepo {
  return { canonical: `${host}/${path}`, host, path };
}

function finish(host: string, rawPath: string): CanonicalizeResult {
  const segments = splitAndValidateSegments(rawPath);
  if (!Array.isArray(segments)) {
    return segments;
  }
  const canonical = build(host, stripGitSuffix(segments).join("/")).canonical;
  // Removing the `.git` presentation suffix can uncover a component the
  // canonical grammar refuses — `.git.git` leaves a bare `.git`, and `..git`
  // leaves a relative `.`. The suffix rule runs on the remote's spelling, so
  // the finished identity is checked against the canonical grammar before it
  // is returned: whatever this function accepts must also be accepted by
  // `validateCanonicalRepoIdentity`, or a remote could be bound to an
  // identity the receiver would then refuse to read back.
  return validateCanonicalRepoIdentity(canonical);
}

/**
 * `https://[user@]<host>/<owner>/<repo>[.git]`
 *
 * A bare username is tolerated and discarded — it names no repository. A
 * `user:token@` pair is refused rather than discarded: a remote carrying
 * embedded credentials is not a form RepoBD supports, and silently accepting
 * it would invite credentials into places they should never travel.
 */
function canonicalizeHttps(rest: string): CanonicalizeResult {
  const pathStart = rest.indexOf("/");
  if (pathStart === -1) {
    return fail("invalid-path", "remote has no repository path");
  }
  const authority = splitAuthority(rest.slice(0, pathStart));
  if ("ok" in authority) {
    return authority;
  }
  if (authority.userinfo !== null && authority.userinfo.includes(":")) {
    return fail("credentials", "remote embeds credentials");
  }
  const host = parseHostPort(authority.hostPort, "https");
  if (typeof host !== "string") {
    return host;
  }
  return finish(host, rest.slice(pathStart));
}

/**
 * `ssh://git@<host>[:22]/<owner>/<repo>[.git]`
 *
 * The `git` user is required. Any other user makes this an arbitrary SSH
 * target — `alice@host:repo` addresses whatever that account's shell resolves,
 * which RepoBD does not model and must not guess at.
 */
function canonicalizeSshUri(rest: string): CanonicalizeResult {
  const pathStart = rest.indexOf("/");
  if (pathStart === -1) {
    return fail("invalid-path", "remote has no repository path");
  }
  const authority = splitAuthority(rest.slice(0, pathStart));
  if ("ok" in authority) {
    return authority;
  }
  if (authority.userinfo !== PROVIDER_SSH_USER) {
    return fail("unsupported-ssh-user", "hosted SSH remotes use the git account");
  }
  const host = parseHostPort(authority.hostPort, "ssh");
  if (typeof host !== "string") {
    return host;
  }
  return finish(host, rest.slice(pathStart));
}

/**
 * `git@<host>:<owner>/<repo>[.git]`
 *
 * scp-like syntax has no port field: everything after the colon is the path,
 * matching Git itself. Requiring the `git` user also settles what would
 * otherwise be ambiguous — `C:/repo` cannot be read as a host here, and an
 * absolute target such as `git@host:/srv/repo` fails the path rules.
 */
function canonicalizeScpLike(raw: string, colon: number): CanonicalizeResult {
  const authority = splitAuthority(raw.slice(0, colon));
  if ("ok" in authority) {
    return authority;
  }
  if (authority.userinfo !== PROVIDER_SSH_USER) {
    return fail("unsupported-ssh-user", "hosted SSH remotes use the git account");
  }
  const rawPath = raw.slice(colon + 1);
  // An absolute or home-relative target names a filesystem location on the
  // server, not a hosted repository. It is refused explicitly, because the
  // path rules would otherwise absorb the leading `/` and read
  // `git@host:/srv/repo` as the repository `srv/repo`.
  if (rawPath.startsWith("/") || rawPath.startsWith("~")) {
    return fail("local-path", "SSH remote names a filesystem path");
  }
  // No port is parsed here by design, so `git@host:2222/owner/repo` names the
  // path `2222/owner/repo` — which is not equal to `owner/repo` and so cannot
  // collide with it.
  const host = parseHostPort(authority.hostPort, "scp");
  if (typeof host !== "string") {
    return host;
  }
  return finish(host, rawPath);
}

/**
 * Canonicalizes an effective remote fetch URL into a hosted repository
 * identity.
 *
 * Supported: HTTPS, scp-like SSH, and `ssh://` URIs for GitHub.com,
 * GitLab.com, and Bitbucket Cloud. Everything else fails closed — see the
 * scope note at the top of this file.
 */
export function canonicalizeSupportedRemote(raw: string): CanonicalizeResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return fail("empty", "input is empty");
  }
  if (!isPrintableAscii(trimmed)) {
    return fail("non-ascii", "input has non-ASCII or control characters");
  }
  if (trimmed.includes("\\")) {
    // Covers `C:\repo` and UNC forms such as `\\server\share`.
    return fail("windows-path", "input contains a backslash");
  }
  if (WINDOWS_DRIVE_PATTERN.test(trimmed)) {
    return fail("windows-path", "input is a Windows drive path");
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith(".")
  ) {
    return fail("local-path", "input is a local or relative path");
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return fail("query-or-fragment", "input has a query or fragment");
  }

  const schemeMatch = SCHEME_PREFIX_PATTERN.exec(trimmed);
  if (schemeMatch !== null) {
    const scheme = schemeMatch[1]?.toLowerCase();
    const rest = trimmed.slice(schemeMatch[0].length);
    if (scheme === "https") {
      return canonicalizeHttps(rest);
    }
    if (scheme === "ssh") {
      return canonicalizeSshUri(rest);
    }
    // `http://` and `git://` are unencrypted and are not supported clone
    // forms for these providers; every other scheme is out of scope outright.
    return fail("unsupported-scheme", `scheme ${String(scheme)} is not supported`);
  }

  // Git's own rule: with no scheme, a colon before the first slash means
  // scp-like syntax.
  const colon = trimmed.indexOf(":");
  const slash = trimmed.indexOf("/");
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    return canonicalizeScpLike(trimmed, colon);
  }
  return fail("malformed", "input is not a supported remote URL form");
}

/**
 * Validates a value already claimed to be a canonical identity, such as the
 * `repo` field of a received binding descriptor.
 *
 * This is intentionally a separate grammar from the remote parser, and a
 * canonical identity is never fed back through `canonicalizeSupportedRemote`.
 * The two describe different things — one a provider's clone URL, the other
 * RepoBD's locator — and blurring them would give a single repository more
 * than one accepted spelling on the wire.
 *
 * The parsed value is accepted only when it re-renders to exactly the input,
 * which rejects every near-canonical spelling in one comparison: a scheme,
 * userinfo, a port, an uppercase host, a `.git` suffix, and leading, trailing,
 * or repeated slashes.
 */
export function validateCanonicalRepoIdentity(
  value: string,
): CanonicalizeResult {
  if (value === "") {
    return fail("empty", "value is empty");
  }
  if (!isPrintableAscii(value)) {
    return fail("non-ascii", "value has non-ASCII or control characters");
  }

  const slash = value.indexOf("/");
  if (slash === -1) {
    return fail("invalid-path", "value has no path");
  }
  const host = value.slice(0, slash);
  if (!SUPPORTED_HOST_SET.has(host)) {
    // Also catches an uppercase host: the supported set is lowercase, so a
    // canonical value that is not already lowercased cannot match.
    return fail("unsupported-host", "host is not a supported provider");
  }

  const segments = splitAndValidateSegments(value.slice(slash + 1));
  if (!Array.isArray(segments)) {
    return segments;
  }
  const repo = build(host, segments.join("/"));
  if (repo.canonical !== value) {
    return fail("malformed", "value is not in canonical form");
  }
  return { ok: true, repo };
}
