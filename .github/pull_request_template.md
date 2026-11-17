## What Problem This Solves

<!--
Describe the concrete problem for consumers of `@openclaw/fs-safe`.
In 1–3 plain-language sentences, explain the affected person’s task, what fails
or is missing, and why it matters. Include the trigger when known; do not invent
a bug for other changes. Write for readers who have not read the implementation.

Good: "Application developers extracting an uploaded archive can overwrite files
outside the chosen folder, putting unrelated application data at risk."
Bad: "Fixes the parent traversal check in the archive parser."

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

Start with the behavior checked and the observed result in plain language; note
meaningful gaps. Put exact commands, commit hashes, and long logs in links or
optional <details>. Do not make readers decode commands to learn what was verified.
-->

- [ ] Tests added or updated when behavior changed
- [ ] Security and compatibility impact considered
- [ ] `CHANGELOG.md` updated when release-relevant
- [ ] No credentials, private paths, private hosts, or sensitive contents included

<!--
Optional linked context:
Add a visible `Closes #<issue-number>` or `Related: #<issue-number>` line.

Required PR title:
type(scope): <what changes for the person affected>
Name the affected task and the symptom or outcome, not just the implementation.
Good: fix(archive): keep uploaded archives inside the chosen folder
Bad: fix(archive): add a parent segment guard
Good: docs(root): help developers choose a folder for untrusted files
Bad: docs(root): update the root factory examples
For internal-only work, name the real developer or operator workflow affected;
do not invent an end-user benefit.

Types: feat, fix, improve, refactor, docs, chore.
Suggested scopes: root, path, archive, atomic, store, secrets, permissions,
exports, build, ci, deps, docs, tests.
-->
