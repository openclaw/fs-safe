---
title: Overview
permalink: /
description: "Capability-style filesystem roots for Node.js apps that handle untrusted relative paths."
---

# fs-safe

Trusted Node.js code that has to touch caller-controlled paths inside a directory it owns gets one boundary it can rely on. `root()` returns a capability-style handle that resolves every relative path against a real directory, refuses anything that escapes it, pins the file you opened, and verifies the write landed where you intended.

Think Go's `os.Root` / `OpenInRoot` or Rust's [`cap-std`](https://github.com/bytecodealliance/cap-std), but for Node. `root()` is the product; everything else in this doc set — JSON stores, atomic writes, secret files, archive extraction, temp workspaces — is supporting cast for the same boundary.

## Why

`path.resolve(root, input).startsWith(root)` validates a string. It does not pin the file you opened, defend against a symlink retarget between check and use, reject hardlinked aliases, or verify that a write landed where you intended after a rename. `fs-safe` does those things, packaged so every call site picks up the same defense without re-implementing it.

This is a **library-level guardrail**, not OS-level isolation. It does not replace containers, seccomp, AppArmor, or filesystem permissions. It is for code that already runs with the privileges of its workspace and wants to stop trivial path tricks from escaping it. Typical fits: agent runtimes, plugin systems, upload extraction, local workspaces, CLIs — anywhere trusted code touches untrusted relative path names.

## Hello world

```ts
import { root } from "@openclaw/fs-safe";

const fs = await root("/safe/workspace", {
  hardlinks: "reject",
  symlinks: "reject",
  mkdir: true,
});

await fs.write("notes/today.txt", "hello\n");
const text = await fs.readText("notes/today.txt");
const parsed = await fs.readJson<{ users: string[] }>("config.json");
await fs.copyIn("uploads/upload.png", "/tmp/upload.png");
await fs.move("notes/today.txt", "notes/archive/today.txt", { overwrite: true });
await fs.remove("notes/archive/today.txt");
```

## Pick your path

- **First time?** [Install](install.md), then walk through the [Quickstart](quickstart.md). Five minutes from `pnpm add` to a working root.
- **Designing a workspace feature.** Read the [Security model](security-model.md) before you trust the boundary, the [Python helper policy](python-helper.md) before you pick deployment defaults, and the [Errors](errors.md) reference so you know what to catch.
- **Replacing ad-hoc atomic writes.** Jump to [Atomic writes](atomic.md) or, for keyed JSON state, [JSON files](json.md).
- **Extracting an upload.** Start at [Archive extraction](archive.md) — handles ZIP and TAR with traversal, link, count, and byte limits.
- **Running an agent in a sandbox.** [Private temp workspaces](temp.md) plus [secret files](secret-file.md) cover the common scratch-and-credentials shape.
- **Looking up a name.** Use the [reference](errors.md) section in the sidebar — every public function has a page.

## What you get

| Surface | Use it for |
|---|---|
| [`root()`](root.md) | One boundary for read/write/move/remove inside a trusted directory. |
| [`@openclaw/fs-safe/config`](config.md) | Process-global Python helper and lock-option defaults. |
| [Python helper policy](python-helper.md) | Choose `auto`, `off`, or `require` for POSIX fd-relative hardening. |
| [`replaceFileAtomic`](atomic.md) | Sibling-temp + rename, fsync hooks, mode preservation, copy fallback. |
| [`writeExternalFileWithinRoot`](output.md) | Stage external-library file output in private temp storage, then finalize under a root. |
| [`writeJson` / `readJson*`](json.md) | JSON state files with strict and lenient read variants. |
| [`@openclaw/fs-safe/store`](store.md) | Overview of `fileStore`, `fileStoreSync`, and `jsonStore`. |
| [`jsonStore`](json-store.md) | Single JSON state file with explicit fallback, atomic writes, and optional locking. |
| [`fileStore`](file-store.md) | Managed multi-file/blob store with modes, stream writes, copy-in, pruning, and private mode. |
| [Private file-store mode](private-file-store.md) | `fileStore({ private: true })` for private JSON/text state at 0600 under 0700 dirs. |
| [`tempWorkspace`](temp.md) | 0700 scratch dir with auto-cleanup. |
| [`readSecureFile`](secure-file.md) | Absolute file reads with fd pinning, permissions, owner, size, and timeout checks. |
| [`walkDirectory`](walk.md) | Budget-bounded recursive directory scan with symlink policy and filters. |
| [`extractArchive`](archive.md) | ZIP/TAR extraction with size, count, link, and traversal limits. |
| [Secret files](secret-file.md) | Mode-0600 credentials with size and TOCTOU defense. |
| [Permissions](permissions.md) | POSIX mode and Windows ACL inspection/remediation helpers. |
| [`acquireFileLock`](sidecar-lock.md) | Cross-process file lock with retry and fail-closed stale-lock handling. |
| [`FsSafeError`](errors.md) | Closed code union (with `policy` / `operational` category) you can branch on. |
| [`pathScope()`](path-scope.md) | Lower-level absolute-path boundary helper; lives behind `@openclaw/fs-safe/advanced`. |
| [`@openclaw/fs-safe/advanced`](advanced.md) | Directory of lower-level composition helpers (path scopes, regular-file I/O, install paths, sibling-temp writes, …). |
| [`@openclaw/fs-safe/test-hooks`](test-hooks.md) | Test-only injection hooks for reproducing open/lstat races. |

## Status

Currently `0.x` — APIs are stable in shape but may be tightened before `1.0`. The [CHANGELOG](https://github.com/openclaw/fs-safe/blob/main/CHANGELOG.md) tracks visible changes. Issues and PRs at the [GitHub repo](https://github.com/openclaw/fs-safe).

Released under the [MIT license](https://github.com/openclaw/fs-safe/blob/main/LICENSE).
