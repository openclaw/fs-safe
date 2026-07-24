## What Problem This Solves

<!--
Describe the concrete problem for consumers of `@openclaw/fs-safe`.
For fixes, begin with:
"Fixes an issue where consumers <do X> would <experience Y> when <condition>."
or:
"Resolves a problem where..."

Name the affected filesystem surface: root confinement, path validation,
identity checks, archive extraction, permissions, atomic operations, stores,
secrets, exports, packaging, or supported platforms. Do not describe only the
code-level cause.
-->

## Why This Change Was Made

<!--
In one or two sentences, explain the complete shipped solution, key design
decisions, and relevant boundaries or non-goals. Call out security,
compatibility, export, error-shape, default, or platform implications.
-->

## User Impact

<!--
State what package consumers can now do or expect. If the change is breaking,
describe the migration path. If it affects only tooling, tests, or docs and
ships nothing new in the package, say so plainly.
-->

## Evidence

<!--
Show the most useful proof that this change works:

- focused regression or security tests
- output of `pnpm check`
- tarball/import proof from `pnpm pack:check`
- platform or filesystem-specific reproduction
- CI links or redacted logs
-->

- [ ] Tests added or updated when behavior changed
- [ ] Security and compatibility impact considered
- [ ] `CHANGELOG.md` updated when release-relevant
- [ ] No credentials, private paths, private hosts, or sensitive contents included

<!--
Optional linked context:
Add a visible `Closes #<issue-number>` or `Related: #<issue-number>` line.

Required PR title:
type(scope): user-facing description

Types: feat, fix, improve, refactor, docs, chore.
Suggested scopes: root, path, archive, atomic, store, secrets, permissions,
exports, build, ci, deps, docs, tests.
-->
