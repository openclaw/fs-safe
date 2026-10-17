---
title: Compiler qualification investigation
description: "Hypotheses, experiments, and acceptance gates for tsc-ts and scriptc in fs-safe."
---

# Compiler qualification investigation

Status: investigation plan, 2026-10-17. This document does not qualify a compiler, runtime, or package change.

Investigate two separate capabilities:

1. Use **tsc-ts** to check TypeScript and emit the existing Node.js package faster.
2. Use **scriptc** to compile fs-safe application code into native programs while preserving its safety contracts.

The second capability changes the runtime. A faster compiler does not establish faster filesystem operations.
Keep both investigations open until measurements and contract proof support a decision.
Prepare small draft PRs. Obtain explicit maintainer approval before merging, releasing, or deploying anything.

## Frozen baseline

| Input | Investigation identity |
| --- | --- |
| fs-safe | `0f396cd9cbd05519a9600d95daadcf827bff6b76`, package `0.26.7` |
| Package manager | `pnpm@12.10.1` |
| Official compiler | Lockfile resolves `typescript@7.0.2` |
| tsc-ts source | `7e21c1012710cc438fd30da0f22f30e276d4222b` |
| scriptc source | `66125d783b0e03af6e28843229c10b6436333c08` |
| Candidate binaries | Not selected or executed. Record release, source SHA, platform, package integrity, and executable hash before testing. |

Do not equate a release binary with a later source revision that declares the same package version.
Freeze source, lockfile, compiler libraries, runner, flags, and binary identities for each comparison.
Changes to those inputs require new evidence for the affected experiment.

The current [tsconfig](../tsconfig.json) includes 317 source TypeScript files. It excludes the test tree and JavaScript tooling.
Its contract includes strict NodeNext, ES2022 output, declarations, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`.

The [build script](../scripts/prepack-build.mjs) invokes the official compiler through Node.
It then prepares the Windows helper and Rust/WASM archive artifact.
Measure the compiler separately from the complete build.

The [package API checker](../scripts/public-api-surface.mjs) imports `typescript/unstable/ast` and `typescript/unstable/sync`.
Keep that dependency when evaluating a different compiler CLI.
Its export-name and error-code checks do not prove complete declaration-signature parity.

## Hypotheses and experiments

| ID | Hypothesis | Experiment | Acceptance gate |
| --- | --- | --- | --- |
| H1 | tsc-ts preserves checking and emission. | Compare the official compiler and native tsc-ts on identical source, config, libraries, and consumer fixtures. | Equal exit status and diagnostics. Explain every emitted JS or declaration difference. |
| H2 | Compiler acceleration materially improves this package's workflow. | Measure compiler-only checking, emission, and complete builds separately. | Repeatable benefit on representative runners without hiding failed runs or memory regressions. |
| H3 | Candidate output preserves the published package contract. | Install each generated tarball and exercise all public subpaths, declarations, assets, and lifecycle behavior. | Consumer behavior and types remain compatible. No accidental fallback to official-compiler output. |
| H4 | scriptc supports the host mechanisms fs-safe requires. | Probe real native loading, exact identities, flags, disposal, Workers, and WASM before a whole-library build. | Preserve every required mechanism or identify a reviewed architecture change. Unsupported remains unsupported. |
| H5 | Native compilation helps actual filesystem workloads. | Measure lexical work, guarded I/O, archives, and watch workloads after semantic qualification. | Representative end-to-end gains with unchanged safety, cancellation, and resource ownership. |
| H6 | Differential findings reveal ordinary fs-safe or consumer bugs. | Reproduce each discrepancy with the official compiler and normal Node/Bun. | Establish the violated contract and repair its owner independently of compiler adoption. |
| H7 | A fork is necessary and maintainable. | Minimize an upstream blocker, identify its owner, and test the smallest patch. | Accepted requirement, reproducible defect, bounded maintenance cost, and upstream synchronization plan. |

### Compiler parity protocol

1. Record source and lockfile hashes, effective config, resolved input files, compiler versions, libraries, and binary hashes.
2. Compare the locked official compiler with the candidate native executable.
3. Use the matching TypeScript-Go oracle and Node-hosted tsc-ts to localize disagreements when needed.
4. Compare diagnostics by category, code, relative file, span, and message.
5. Include valid consumers and intentional type errors. A candidate must not silently omit invalid inputs.
6. Compare emitted file inventories and bytes, including every `.js` and `.d.ts` file.
7. Investigate differences before introducing normalization. Preserve error locations and meaningful output differences.
8. Compile consumer fixtures against both declaration sets. Cover overloads, generics, unions, disposal, defaults, and public subpaths.

Reuse upstream corpus and package tests where they answer the same question.
The inspected [upstream benchmark](https://github.com/vercel-labs/tsc-ts/blob/7e21c1012710cc438fd30da0f22f30e276d4222b/packages/tsc-ts/scripts/bench.mjs#L77-L106) needs care.
Its whole-project timer ignores child status, and that comparison omits native tsc-ts.
Record this as an upstream follow-up. Do not use that timing table as fs-safe qualification.

### Performance protocol

Use one isolated runner without competing builds. Record CPU allocation, operating system, filesystem, runtime, and resource limits.
Compare default concurrency and equal checker counts. Report single-threaded results separately.

Start with two warmups and ten measured runs per configuration, with interleaved ABBA/BAAB order.
Report median, spread, wall time, CPU time, and peak RSS. Exclude warmups from reported samples.
Classify nonzero exits, signals, crashes, incomplete output, and timeouts as failures rather than fast samples.
Use a reviewed finite deadline for each experiment and report censored runs.

Distinguish fresh-process runs from filesystem-cache-cold runs. Do not claim cold caches without controlling them.
Measure incremental no-op and one-file edits only as optional scenarios because the current build does not enable incremental compilation.
Measure repeated API/watch operation separately if adoption later includes a persistent compiler process.

Select a material benefit threshold after measuring the baseline and before evaluating candidate timings.
Prefer whole-build savings and runner cost over a microbenchmark ratio.
Do not adopt a candidate that saves negligible time while adding substantial platform or maintenance cost.

### Package and runtime proof

Most runtime tests import source through Vitest. Those tests do not prove candidate-emitted JavaScript.
The experiment must preserve the identity of the generated package through every check.

Run the ordinary baseline through the existing repository commands:
Use a qualified validation host with frozen dependencies and the documented Rust/LLVM toolchain.

```sh
pnpm check
pnpm native:build
pnpm package:smoke
git diff --check
```

For candidate output, compare compiler artifacts before packaging.
Prepare required native/WASM/helper artifacts through their existing owners.
Then run `node scripts/check-pack.mjs` against the candidate's `dist` in its isolated validation checkout.
This checker packs with `--ignore-scripts`, imports public subpaths, and runs installed-package smoke checks.
Add focused installed-package behavior probes where current source tests leave a gap.

Do not run `pnpm pack:check` or `pnpm check` over candidate output and claim that output survived.
Those commands rebuild with the official compiler in the frozen baseline.
Do not update `test/public-api.json` merely to accept compiler differences.

Reuse the existing security cohort plus these representative lifecycle tests:

- `test/root-read-final-fence.test.ts`
- `test/atomic-restore-error-precedence.test.ts`
- `test/atomic-restoration-falsy-settlement.test.ts`
- `test/descriptor-close-ownership.test.ts`
- `test/root-create-native-integration.test.ts`
- `test/root-mkdir-post-create.test.ts`
- `test/root-write-lifetime.test.ts`
- `test/temp-workspace-cleanup-capability.test.ts`
- `test/native-worker-fd-ownership.test.ts`
- `test/native-init-context.test.ts`
- `test/value-adapter-contracts.test.ts`
- `test/public-api-surface.test.ts`

For runtime changes, preserve the documented [platform matrix](contributing.md) and [native capabilities](native.md).
Stage qualification from Linux to macOS and Windows, then the remaining supported native targets.
Cover Node 22/24/26, native `off`/`auto`/`require`, supported Bun lanes, glibc/musl, and FreeBSD's narrower native surface.
Use the existing Bun native proofs. The full Bun suite is diagnostic, not an assumed passing compatibility gate.
Keep cross-build success separate from execution on the target operating system.

Exercise concurrent replacement with an external process where runtime scheduling could bypass an in-process race fixture.
Observe rejection, file contents, identity, descriptor ownership, cleanup, error precedence, cancellation, and event-loop delay.
Successful returns alone do not prove safety or cleanup.

## scriptc feasibility gates

The frozen upstream explicitly excludes [N-API addons](https://github.com/vercel-labs/scriptc/blob/66125d783b0e03af6e28843229c10b6436333c08/docs/content/limitations/native-addons.mdx).
It also excludes [computed numeric flags](https://github.com/vercel-labs/scriptc/blob/66125d783b0e03af6e28843229c10b6436333c08/docs/content/limitations/builtin-apis/filesystem-flags.mdx)
and [BigInt filesystem stats](https://github.com/vercel-labs/scriptc/blob/66125d783b0e03af6e28843229c10b6436333c08/docs/content/limitations/builtin-apis/filehandle-and-descriptor-i-o.mdx).
Its filesystem operations complete synchronously before callbacks or promise continuations.
These documented limits are feasibility constraints, not newly demonstrated compiler defects.

| fs-safe owner | Required probe |
| --- | --- |
| `src/native.ts`, `src/native-binding.ts` | Lazy addon loading, async-context isolation, per-operation capabilities, and exactly-once descriptor close. |
| `src/file-identity.ts`, `src/exact-identity.ts` | BigInt identity, safe-integer rejection, Windows unknown identity, getter evaluation, and cleanup authority. |
| `src/root-read-admission.ts`, `src/root-write-verification.ts` | Fresh boundary observations, hardlink rejection, retained-parent authority, and post-operation identity fences. |
| `src/byte-budget.ts`, `src/errors.ts`, `src/async-lock.ts`, `src/suppressed-error.ts` | Small pure-TS probes for numeric boundaries, error identity, FIFO release, and cleanup-error precedence. |
| `src/archive-tar-wasm.ts`, `src/archive-zip-loader.ts` | WASM memory growth, chunk limits, physical EOF, cancellation, disposal, optional imports, and object identity. |
| `src/watch-io.ts`, `src/directory-receipt.ts` | Worker lifetime, event ordering, and WeakMap-held capability identity. |

Start with minimal unchanged-code probes, then test the actual public package.
An import-only success or native-off run does not qualify the native-required path.
Never replace BigInt identity with Number, retained descriptors with pathnames, or independent observations with cached values to make compilation succeed.

If a C ABI adapter is necessary, review its design before implementation.
Prefer reusing the existing Rust mechanisms while keeping policy in TypeScript.
Specify handle ownership, errors, cancellation, platform behavior, and ABI compatibility first.
Do not create a second filesystem policy engine.

## Draft PR structure

Use dependency links only where one change actually requires another.

| PR | Scope | Prerequisite |
| --- | --- | --- |
| P1 | Compiler parity and measurement harness. Preserve official build defaults. | Frozen input and output identities, trustworthy failure accounting. |
| P2 | Candidate-package and declaration consumer proof missing from existing checks. | P1 artifact contract. |
| P3a, P3b, ... | One confirmed fs-safe or OpenClaw consumer defect per PR. | Minimal normal-runtime reproduction and owner agreement. |
| P4 | Optional compiler selection through the existing build owner. | H1-H3 pass and material measured benefit. Retain the official API dependency. |
| R1, R2, ... | Narrow runtime compatibility fixes or an accepted ABI design. | H4 findings, security-boundary review, and relevant platform proof. |
| U1, U2, ... | Reduced upstream regression tests and fixes. | Confirmed compiler/runtime owner and failing supported contract. |

P1 -> P2 -> P4 forms the compiler stack. Verified fixes join that dependency chain only when necessary.
Runtime work forms a separate reviewed stack. Do not couple ordinary Node fixes to compiler adoption.
Coordinate OpenClaw consumer changes with their existing owners and reuse shared benchmark evidence where inputs match.

## Fork decision

Choose the owning project: tsc-ts for checker/emitter defects, scriptc for lowering/runtime defects, fs-safe for its own invariant violations.
A documented unsupported feature is an architecture discussion before it is a fork justification.

Before creating a fork:

1. Preserve a minimal reproducer with expected and actual behavior.
2. Check the pinned version and current upstream for an existing fix.
3. Show that the blocker prevents an accepted fs-safe requirement.
4. Estimate the patch surface, platform tests, release ownership, and upstream synchronization cost.
5. Define an upstream contribution route and a fork retirement condition.

## Completion evidence

This plan is the first deliverable. It does not complete compiler qualification or runtime adoption.
Every experiment must report `pass`, `fail`, `unsupported`, or `not run`, with its exact inputs and evidence.
Keep the full objective open while required tests, verified fixes, stack preparation, or architecture decisions remain unresolved.

The final handoff must identify measured benefits, semantic differences, package/platform coverage, remaining blockers, and every draft PR dependency.
Keep source validation, CI status, merge approval, release publication, and deployed behavior separate.
No landing occurs without explicit maintainer approval.
