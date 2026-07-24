# Security Policy

If you believe you found a security issue in `@openclaw/fs-safe`, report it
privately.

## Reporting

Open a private report through
[GitHub Security Advisories](https://github.com/openclaw/fs-safe/security/advisories/new)
or email `security@openclaw.ai`.

Include:

1. affected version or commit
2. Node.js version, operating system, filesystem, and mount details
3. minimal reproduction
4. demonstrated impact
5. suggested remediation, if known

Do not open a public issue until maintainers have coordinated disclosure.

## Scope

Security issues in scope generally include:

- traversal or root-confinement bypasses
- symlink, hardlink, rename, or identity-swap races that cross a documented
  filesystem boundary
- archive extraction outside the intended destination
- unsafe secret-file, permission, ownership, or temporary-file behavior
- package or release-pipeline compromise affecting the published package

Reports must demonstrate a concrete boundary bypass or impact. Applications
remain responsible for operating-system isolation, authorization, and choosing
trusted root directories unless this package documents and fails to enforce a
specific invariant.

## Operational Guidance

- Keep `@openclaw/fs-safe`, Node.js, and optional archive dependencies current.
- Treat pathnames and archive contents as untrusted.
- Use OS-level sandboxing when the threat model includes a hostile process.
- Pin and review dependency updates before publishing.

There is currently no paid bug bounty program.
