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

10. v0.1 repository binding exists to prevent accidental misuse, not malicious local impersonation.
11. Folder names and absolute paths are never repository identity.
12. Git is used read-only for repository identification.
13. RepoBD must not modify Git config, commit, push, merge, create PRs, or deploy.

## File safety

14. Secret writes must be limited to explicitly allowed targets.
15. Path traversal outside allowed repository scope must be rejected.
16. Symlink write targets must be rejected.
17. `.git/**`, executables, scripts, and unrelated project files must not be written as secret targets.
18. Existing secret values must not be silently overwritten.
19. RepoBD must never execute a secret or automatically run an application after applying it.

## Lifecycle and failure

20. Repository mismatch must block apply.
21. Repository mismatch must not consume a still-valid remote secret.
22. User cancellation before apply must not consume the remote secret.
23. Operational failure before verified successful write must not consume the remote secret.
24. Successful verified write must be followed by one-time consume/invalidation.
25. Concurrent attempts must not result in more successful consumes than configured.
26. Expired or already-consumed deliveries must fail closed.
27. On local failure, discard plaintext/temp state as far as practical and leave no unintended file residue.

## Product and abuse surface

28. Maximum plaintext payload for v0.1 is 64 KiB.
29. No file-upload feature in v0.1.
30. No public secret listing, directory, or search.
31. No permanent-storage mode in v0.1.
32. Abuse prevention should use rate limits, retention limits, traffic metadata, and manual invalidation—not plaintext inspection.

## Development rule

33. Security correctness outranks code minimalism, performance micro-optimization, and UX convenience.
34. Any change touching these invariants requires explicit security review before commit/push/deploy.
