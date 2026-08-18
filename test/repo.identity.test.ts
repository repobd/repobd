import { describe, expect, it } from "vitest";
import {
  SUPPORTED_HOSTS,
  canonicalizeSupportedRemote,
  validateCanonicalRepoIdentity,
  type CanonicalizeFailureReason,
} from "../src/repo/identity.js";

// These tests describe the RepoBD v0.1 product contract, not generic Git
// remote semantics: common hosted remotes on GitHub.com, GitLab.com, and
// Bitbucket Cloud canonicalize, and everything else fails closed. A case that
// asserts `unsupported-*` is asserting intended behavior, not a known gap.

function canonical(raw: string): string {
  const result = canonicalizeSupportedRemote(raw);
  if (!result.ok) {
    throw new Error(`expected ${raw} to canonicalize, got ${result.reason}`);
  }
  return result.repo.canonical;
}

function rejection(raw: string): CanonicalizeFailureReason {
  const result = canonicalizeSupportedRemote(raw);
  if (result.ok) {
    throw new Error(
      `expected ${raw} to be rejected, got ${result.repo.canonical}`,
    );
  }
  return result.reason;
}

describe("supported hosted remotes", () => {
  it("canonicalizes the GitHub HTTPS and SSH spellings of one repository", () => {
    const expected = "github.com/repobd/repobd";
    expect(canonical("https://github.com/repobd/repobd.git")).toBe(expected);
    expect(canonical("https://github.com/repobd/repobd")).toBe(expected);
    expect(canonical("git@github.com:repobd/repobd.git")).toBe(expected);
    expect(canonical("git@github.com:repobd/repobd")).toBe(expected);
    expect(canonical("ssh://git@github.com/repobd/repobd.git")).toBe(expected);
  });

  it("canonicalizes the GitLab spellings, including nested groups", () => {
    expect(canonical("https://gitlab.com/group/project.git")).toBe(
      "gitlab.com/group/project",
    );
    expect(canonical("git@gitlab.com:group/project.git")).toBe(
      "gitlab.com/group/project",
    );
    // Group nesting is preserved rather than flattened to owner/repo.
    const nested = "gitlab.com/group/subgroup/project";
    expect(canonical("https://gitlab.com/group/subgroup/project.git")).toBe(
      nested,
    );
    expect(canonical("git@gitlab.com:group/subgroup/project.git")).toBe(nested);
  });

  it("canonicalizes the Bitbucket Cloud spellings", () => {
    const expected = "bitbucket.org/workspace/project";
    expect(canonical("https://bitbucket.org/workspace/project.git")).toBe(
      expected,
    );
    expect(canonical("git@bitbucket.org:workspace/project.git")).toBe(expected);
    expect(canonical("ssh://git@bitbucket.org/workspace/project.git")).toBe(
      expected,
    );
  });

  it("accepts a default port written out and drops it", () => {
    expect(canonical("https://github.com:443/repobd/repobd.git")).toBe(
      "github.com/repobd/repobd",
    );
    expect(canonical("ssh://git@github.com:22/repobd/repobd.git")).toBe(
      "github.com/repobd/repobd",
    );
  });

  it("lowercases the host", () => {
    expect(canonical("https://GitHub.com/repobd/repobd.git")).toBe(
      "github.com/repobd/repobd",
    );
    expect(canonical("git@GITHUB.COM:repobd/repobd.git")).toBe(
      "github.com/repobd/repobd",
    );
  });

  it("preserves repository path case", () => {
    expect(canonical("https://github.com/RepoBD/RepoBD.git")).toBe(
      "github.com/RepoBD/RepoBD",
    );
    // The mirror image of the rule: folding case here would merge two
    // repositories that a case-sensitive host keeps apart.
    expect(canonical("https://github.com/RepoBD/RepoBD.git")).not.toBe(
      canonical("https://github.com/repobd/repobd.git"),
    );
  });

  it("discards a bare username in an HTTPS remote", () => {
    expect(canonical("https://someone@github.com/repobd/repobd.git")).toBe(
      "github.com/repobd/repobd",
    );
  });

  it("absorbs trailing and repeated slashes", () => {
    expect(canonical("https://github.com/repobd/repobd.git/")).toBe(
      "github.com/repobd/repobd",
    );
    expect(canonical("https://github.com//repobd//repobd.git")).toBe(
      "github.com/repobd/repobd",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(canonical("  https://github.com/repobd/repobd.git\n")).toBe(
      "github.com/repobd/repobd",
    );
  });
});

describe(".git suffix handling", () => {
  it("removes exactly one presentation suffix", () => {
    // A repository genuinely named `repo.git` is cloned from `repo.git.git`.
    expect(canonical("https://github.com/repobd/repo.git.git")).toBe(
      "github.com/repobd/repo.git",
    );
  });

  it("does not treat a bare .git component as a suffix", () => {
    // Stripping here would invent the parent repository `repobd/repo`.
    expect(rejection("https://github.com/repobd/repo/.git")).toBe(
      "ambiguous-git-suffix",
    );
    expect(rejection("https://github.com/repobd/.git")).toBe(
      "ambiguous-git-suffix",
    );
  });

  it("leaves names that merely start with .git alone", () => {
    expect(canonical("https://github.com/repobd/.gitignore")).toBe(
      "github.com/repobd/.gitignore",
    );
    expect(canonical("https://github.com/repobd/.github")).toBe(
      "github.com/repobd/.github",
    );
  });

  it("keeps a name that only contains .git in the middle", () => {
    expect(canonical("https://github.com/repobd/my.git.tools")).toBe(
      "github.com/repobd/my.git.tools",
    );
  });

  it("refuses a name that is only canonical before the suffix is removed", () => {
    // Removing the suffix would uncover a bare `.git` or a relative segment,
    // neither of which is a canonical identity. Fail closed instead.
    expect(rejection("https://github.com/owner/.git.git")).toBe(
      "ambiguous-git-suffix",
    );
    expect(rejection("https://github.com/owner/..git")).toBe("invalid-path");
    expect(rejection("https://github.com/owner/...git")).toBe("invalid-path");
    expect(rejection("git@github.com:owner/..git")).toBe("invalid-path");
    expect(rejection("ssh://git@github.com/owner/.git.git")).toBe(
      "ambiguous-git-suffix",
    );
  });
});

describe("unsupported hosts", () => {
  it("blocks self-hosted and unknown hosts", () => {
    expect(rejection("https://git.example.com/team/service.git")).toBe(
      "unsupported-host",
    );
    expect(rejection("git@git.example.com:team/service.git")).toBe(
      "unsupported-host",
    );
    expect(rejection("https://github.example.com/o/r.git")).toBe(
      "unsupported-host",
    );
  });

  it("blocks provider SSH aliases rather than normalizing them", () => {
    // `ssh.github.com` is a different endpoint. RepoBD keeps no alias table,
    // so this blocks instead of silently becoming github.com.
    expect(rejection("ssh://git@ssh.github.com/repobd/repobd.git")).toBe(
      "unsupported-host",
    );
    expect(rejection("git@ssh.github.com:repobd/repobd.git")).toBe(
      "unsupported-host",
    );
    expect(rejection("https://altssh.bitbucket.org/workspace/repo.git")).toBe(
      "unsupported-host",
    );
  });

  it("blocks a self-hosted GitLab", () => {
    expect(rejection("https://gitlab.internal/group/project.git")).toBe(
      "unsupported-host",
    );
  });
});

describe("unsupported transports", () => {
  it("blocks plain HTTP and the git protocol", () => {
    expect(rejection("http://github.com/repobd/repobd.git")).toBe(
      "unsupported-scheme",
    );
    expect(rejection("git://github.com/repobd/repobd.git")).toBe(
      "unsupported-scheme",
    );
  });

  it("blocks other schemes outright", () => {
    expect(rejection("file:///srv/repo.git")).toBe("unsupported-scheme");
    expect(rejection("ftp://github.com/repobd/repobd.git")).toBe(
      "unsupported-scheme",
    );
  });

  it("blocks non-default ports", () => {
    expect(rejection("https://github.com:8443/repobd/repobd.git")).toBe(
      "unsupported-port",
    );
    expect(rejection("ssh://git@github.com:2222/repobd/repobd.git")).toBe(
      "unsupported-port",
    );
    // Written-out port must match its own scheme's default, not any default.
    expect(rejection("ssh://git@github.com:443/repobd/repobd.git")).toBe(
      "unsupported-port",
    );
    expect(rejection("https://github.com:22/repobd/repobd.git")).toBe(
      "unsupported-port",
    );
  });
});

describe("unsupported SSH targets", () => {
  it("blocks SSH users other than the provider account", () => {
    expect(rejection("alice@github.com:repobd/repobd.git")).toBe(
      "unsupported-ssh-user",
    );
    expect(rejection("bob@github.com:repobd/repobd.git")).toBe(
      "unsupported-ssh-user",
    );
    expect(rejection("ssh://alice@github.com/repobd/repobd.git")).toBe(
      "unsupported-ssh-user",
    );
    // No user at all is equally not the hosted form.
    expect(rejection("github.com:repobd/repobd.git")).toBe(
      "unsupported-ssh-user",
    );
  });

  it("blocks absolute and home-relative server paths", () => {
    expect(rejection("git@github.com:/srv/git/repo.git")).toBe("local-path");
    expect(rejection("git@github.com:~alice/repo.git")).toBe("local-path");
  });

  it("blocks a single-component SSH target", () => {
    expect(rejection("git@github.com:repo.git")).toBe("invalid-path");
  });
});

describe("local, relative, and Windows paths", () => {
  it("blocks POSIX local and relative paths", () => {
    expect(rejection("/srv/git/repo.git")).toBe("local-path");
    expect(rejection("~/repo.git")).toBe("local-path");
    expect(rejection(".")).toBe("local-path");
    expect(rejection("..")).toBe("local-path");
    expect(rejection("./repo")).toBe("local-path");
    expect(rejection("../other/repo")).toBe("local-path");
  });

  it("blocks Windows drive and UNC paths", () => {
    expect(rejection("C:/repos/project")).toBe("windows-path");
    expect(rejection("C:\\repos\\project")).toBe("windows-path");
    expect(rejection("\\\\server\\share\\repo")).toBe("windows-path");
  });

  it("blocks a bare relative path with no colon", () => {
    expect(rejection("repobd/repobd")).toBe("malformed");
  });
});

describe("malformed and ambiguous input", () => {
  it("blocks empty input", () => {
    expect(rejection("")).toBe("empty");
    expect(rejection("   ")).toBe("empty");
  });

  it("blocks non-ASCII and control characters", () => {
    // A homograph host must never quietly become the real one.
    expect(rejection("https://gıthub.com/repobd/repobd.git")).toBe("non-ascii");
    expect(rejection("https://github.com/repobd/repobd\u0000")).toBe(
      "non-ascii",
    );
  });

  it("blocks query strings and fragments", () => {
    expect(rejection("https://github.com/repobd/repobd.git?ref=main")).toBe(
      "query-or-fragment",
    );
    expect(rejection("https://github.com/repobd/repobd.git#readme")).toBe(
      "query-or-fragment",
    );
  });

  it("blocks embedded credentials", () => {
    expect(
      rejection("https://user:ghp_dummy@github.com/repobd/repobd.git"),
    ).toBe("credentials");
  });

  it("blocks ambiguous userinfo", () => {
    expect(rejection("git@git@github.com:repobd/repobd.git")).toBe(
      "ambiguous-userinfo",
    );
  });

  it("blocks relative segments in the path", () => {
    expect(rejection("https://github.com/repobd/../evil")).toBe("invalid-path");
    expect(rejection("git@github.com:repobd/./repobd")).toBe("invalid-path");
  });

  it("blocks a path that names no repository", () => {
    expect(rejection("https://github.com/repobd")).toBe("invalid-path");
    expect(rejection("https://github.com/")).toBe("invalid-path");
    expect(rejection("https://github.com")).toBe("invalid-path");
  });

  it("blocks invalid path characters", () => {
    expect(rejection("https://github.com/repobd/repo bd")).toBe("non-ascii");
    expect(rejection("https://github.com/repobd/repo%20bd")).toBe(
      "invalid-path",
    );
  });
});

describe("regressions: no unsupported input becomes a false match", () => {
  // Each pair previously risked two different remotes collapsing onto one
  // identity once transport details were dropped. The contract now is that
  // either the input is refused, or it canonicalizes to something that is
  // demonstrably not the plain repository identity.

  it("keeps a non-default port from collapsing onto the default endpoint", () => {
    expect(rejection("ssh://git@github.com:2222/repobd/repobd.git")).toBe(
      "unsupported-port",
    );
    // scp-like has no port field, so this names a path — and that path is not
    // the same identity as repobd/repobd.
    expect(canonical("git@github.com:2222/repobd/repobd.git")).toBe(
      "github.com/2222/repobd/repobd",
    );
    expect(canonical("git@github.com:2222/repobd/repobd.git")).not.toBe(
      "github.com/repobd/repobd",
    );
  });

  it("keeps an unencrypted transport from matching the HTTPS identity", () => {
    expect(rejection("http://github.com/repobd/repobd.git")).toBe(
      "unsupported-scheme",
    );
    expect(rejection("git://github.com/repobd/repobd.git")).toBe(
      "unsupported-scheme",
    );
  });

  it("keeps an arbitrary SSH account from matching the hosted identity", () => {
    expect(rejection("alice@github.com:repobd/repobd.git")).toBe(
      "unsupported-ssh-user",
    );
    expect(rejection("git@github.com:/repobd/repobd.git")).toBe("local-path");
  });

  it("keeps a host alias from matching the real host", () => {
    expect(rejection("git@ssh.github.com:repobd/repobd.git")).toBe(
      "unsupported-host",
    );
  });

  it("keeps distinct supported hosts distinct", () => {
    expect(canonical("https://gitlab.com/repobd/repobd.git")).not.toBe(
      canonical("https://github.com/repobd/repobd.git"),
    );
  });

  it("never produces an identity the canonical validator would refuse", () => {
    // The invariant that ties the two grammars together: a remote the sender
    // could bind must be an identity the receiver can read back. Anything the
    // suffix rule cannot leave canonical has to be refused, not emitted.
    const inputs = [
      "https://github.com/repobd/repobd",
      "https://github.com/repobd/repobd.git",
      "git@github.com:repobd/repobd.git",
      "ssh://git@github.com:22/repobd/repobd.git",
      "https://github.com/repobd/repo.git.git",
      "https://github.com/repobd/.gitignore",
      "https://github.com/repobd/my.git.tools",
      "https://gitlab.com/group/subgroup/project.git",
      "https://bitbucket.org/workspace/project.git",
      "git@github.com:2222/repobd/repobd.git",
      "https://github.com/owner/.git.git",
      "https://github.com/owner/..git",
      "https://github.com/owner/...git",
      "https://github.com/owner/....git",
      "https://github.com/owner/.git.git.git",
      "https://github.com/..git/repo",
      "https://github.com/owner/repo/..git",
    ];
    for (const raw of inputs) {
      const result = canonicalizeSupportedRemote(raw);
      if (!result.ok) {
        continue;
      }
      const readBack = validateCanonicalRepoIdentity(result.repo.canonical);
      expect(
        readBack.ok,
        `${raw} canonicalized to ${result.repo.canonical}, which the validator refused`,
      ).toBe(true);
    }
  });
});

describe("validateCanonicalRepoIdentity", () => {
  function valid(value: string): string {
    const result = validateCanonicalRepoIdentity(value);
    if (!result.ok) {
      throw new Error(`expected ${value} to validate, got ${result.reason}`);
    }
    return result.repo.canonical;
  }

  function invalid(value: string): CanonicalizeFailureReason {
    const result = validateCanonicalRepoIdentity(value);
    if (result.ok) {
      throw new Error(`expected ${value} to be rejected`);
    }
    return result.reason;
  }

  it("accepts canonical identities for every supported host", () => {
    for (const host of SUPPORTED_HOSTS) {
      expect(valid(`${host}/owner/repo`)).toBe(`${host}/owner/repo`);
    }
    expect(valid("gitlab.com/group/subgroup/project")).toBe(
      "gitlab.com/group/subgroup/project",
    );
  });

  it("round-trips every canonicalized remote", () => {
    for (const raw of [
      "https://github.com/repobd/repobd.git",
      "git@gitlab.com:group/subgroup/project.git",
      "ssh://git@bitbucket.org/workspace/project.git",
      // The repository genuinely named `repo.git`: its canonical identity
      // ends in `.git` and must survive being read back.
      "https://github.com/repobd/repo.git.git",
    ]) {
      const identity = canonical(raw);
      expect(valid(identity)).toBe(identity);
    }
  });

  it("refuses a raw remote URL", () => {
    expect(invalid("https://github.com/repobd/repobd")).toBe(
      "unsupported-host",
    );
    expect(invalid("git@github.com:repobd/repobd")).toBe("unsupported-host");
  });

  it("accepts a repository whose own name ends in .git", () => {
    // Not a stray suffix: this is the canonical identity of the repository
    // cloned from `.../repobd.git.git`. The validator must not strip again.
    expect(valid("github.com/repobd/repobd.git")).toBe(
      "github.com/repobd/repobd.git",
    );
  });

  it("refuses near-canonical spellings", () => {
    expect(invalid("github.com/repobd/repobd/")).toBe("malformed");
    expect(invalid("github.com//repobd/repobd")).toBe("malformed");
    expect(invalid("/github.com/repobd/repobd")).toBe("unsupported-host");
    expect(invalid("GitHub.com/repobd/repobd")).toBe("unsupported-host");
  });

  it("refuses a port, which no supported identity carries", () => {
    expect(invalid("github.com:443/repobd/repobd")).toBe("unsupported-host");
    expect(invalid("github.com:2222/repobd/repobd")).toBe("unsupported-host");
  });

  it("refuses unsupported hosts and malformed values", () => {
    expect(invalid("git.example.com/team/service")).toBe("unsupported-host");
    expect(invalid("")).toBe("empty");
    expect(invalid("github.com")).toBe("invalid-path");
    expect(invalid("github.com/repobd")).toBe("invalid-path");
    expect(invalid("github.com/repobd/..")).toBe("invalid-path");
    expect(invalid("github.com/repobd/.git")).toBe("ambiguous-git-suffix");
  });
});

describe("purity", () => {
  it("keeps canonicalization a pure function of its argument", () => {
    const raw = "https://github.com/repobd/repobd.git";
    const first = canonicalizeSupportedRemote(raw);
    const second = canonicalizeSupportedRemote(raw);
    expect(first).toEqual(second);
  });
});
