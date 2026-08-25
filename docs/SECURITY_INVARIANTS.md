# RepoBD Security Invariants

These rules are non-negotiable unless the user explicitly approves a product-level security redesign.

## Plaintext confidentiality

1. **The server must never receive plaintext secret content.**
2. **The server must never receive the decryption key.**
3. **The server must never decrypt, inspect, log, or persist plaintext secret content.**
4. Plaintext must not appear in normal CLI stdout, application logs, Worker logs, analytics, telemetry, error reports, or crash reports.
5. Support and abuse workflows must not require plaintext visibility.

## Cryptography

6. Do not invent cryptography.
7. Use standard native cryptographic primitives such as Web Crypto API / Node native Web Crypto.
8. Prefer authenticated encryption such as AES-GCM when the implementation is finalized.
9. Cryptographic versioning/format changes must be explicit and reviewed.

## Repository context

10. v0.1 repository binding exists to prevent accidental misuse, not malicious local impersonation. It is a guardrail, not authentication: the binding is unsigned, and a compromised OS, modified local Git, or modified RepoBD CLI is out of scope.
11. Folder names and absolute paths are never repository identity.
12. Git is used read-only for repository identification.
13. RepoBD must not modify Git config, commit, push, merge, create PRs, or deploy.
14. **The server must never receive repository identity.** The binding travels only in the delivery link fragment — never in a request payload, URL, log, or stored record.
15. **The repository check must complete before any network secret retrieval.** On mismatch or any repository-resolution failure, no claim is submitted, no ciphertext is fetched, and nothing is consumed.
16. Repository comparison is exact and case-sensitive. No partial, suffix, alias, or fuzzy matching.
17. Supported hosted profiles in v0.1 are github.com, gitlab.com, and bitbucket.org; their common HTTPS and SSH clone forms normalize to one identity. Every other repository environment fails closed. An effective Git origin URL carrying leading or trailing whitespace is malformed and fails closed — it must never be trimmed into validity.
18. A missing, malformed, or unknown-version binding blocks. There is no unbound delivery mode. The delivery fragment grammar is exact: one `k`, one `b`, no repeated and no unknown fields. Ambiguity is refused, never resolved by first-value-wins.
19. The secret id accepted from a delivery link must satisfy the same canonical capability grammar the Worker enforces, checked locally before any request is addressed with it.
20. Except for the single intentional successful `repobd send` output line containing the complete delivery link, the decryption key and the raw delivery fragment must never appear in CLI output, errors, logs, or diagnostics. Neither is ever printed separately, and `repobd pull` must never echo a delivery link it was given. Credential-bearing remote URLs must never appear in output at all.
21. A secret-bearing delivery link must never be accepted as a command-line argument. It is read from stdin, so the supported flow does not reach shell history or process argument listings.
22. CLI diagnostics must never echo user-supplied argv content, for any command, option position, separator, or unknown-command shape. Redaction is centralized on the argument parser's output, applies to malformed input without parsing it, and does not claim to undo the shell's own record of an argument that was already typed.

## File safety

23. Secret writes must be limited to explicitly allowed targets.
24. Path traversal outside allowed repository scope must be rejected.
25. Symlink write targets must be rejected.
26. `.git/**`, executables, scripts, and unrelated project files must not be written as secret targets.
27. Existing secret values must not be silently overwritten.
28. RepoBD must never execute a secret or automatically run an application after applying it.

## Lifecycle and failure

29. Repository mismatch must block apply.
30. Repository mismatch must not consume a still-valid remote secret.
31. User cancellation before apply must not consume the remote secret.
32. Operational failure before verified successful write must not consume the remote secret.
33. Successful verified write must be followed by one-time consume/invalidation.
34. Concurrent attempts must not result in more successful consumes than configured.
35. Expired or already-consumed deliveries must fail closed.
36. On local failure, discard plaintext/temp state as far as practical and leave no unintended file residue.

## Product and abuse surface

37. Maximum plaintext payload for v0.1 is 64 KiB.
38. No file-upload feature in v0.1.
39. No public secret listing, directory, or search.
40. No permanent-storage mode in v0.1.
41. Abuse prevention should use rate limits, retention limits, traffic metadata, and manual invalidation—not plaintext inspection.

## Development rule

42. Security correctness outranks code minimalism, performance micro-optimization, and UX convenience.
43. Any change touching these invariants requires explicit security review before commit/push/deploy.
