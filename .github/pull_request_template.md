## What Problem This Solves

<!--
Describe the concrete problem for consumers of `@openclaw/fs-safe`.
Use one short, plain-language sentence. For fixes, prefer:
"Fixes: <what goes wrong> when <trigger or condition>."
For other changes, describe the need without inventing a bug.

Name the affected filesystem surface: root confinement, path validation,
identity checks, archive extraction, permissions, atomic operations, stores,
secrets, exports, packaging, or supported platforms. Do not describe only the
code-level cause.
-->

## User Impact

<!--
"User impact: <what package consumers can now do or expect>."
Lead with the concrete outcome in plain language, usually one sentence.
For internal-only changes, say there is no user-visible change; do not invent a benefit.
Keep important risks, breaking changes, migrations, and required user actions visible here.
Mention security, compatibility, exports, error shapes, defaults, or platform
impacts only when they change. For breaking changes, describe the migration path.
For tooling, tests, or docs that ship nothing new in the package, say so plainly.
-->

## Why This Change Was Made

<!--
Briefly explain how the change addresses the problem without repeating the impact.
Keep the body short. Leave file lists, internal acronyms, and root-cause walkthroughs
in the diff or optional <details>; include technical detail only when it explains
behavior or a material tradeoff. Do not hide risks or required actions in <details>.
-->

## Evidence

<!--
Show the most useful proof that this change works:

- focused regression or security tests
- output of `pnpm check`
- tarball/import proof from `pnpm pack:check`
- platform or filesystem-specific reproduction
- CI links or redacted logs

Summarize what was checked and the result; note meaningful gaps. Link long output
or put it in optional <details>, keeping the useful evidence summary visible.
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
