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
- **Upgrading from 0.4?** Follow [Migrating to 0.5](migrating-to-0.5.md) in order, including the archive clamp-default audit.
- **Upgrading from 0.5?** Follow [Migrating to 0.6](migrating-to-0.6.md) to adopt platform-native optional packages.
- **Designing a workspace feature.** Read the [Security model](security-model.md) before you trust the boundary, the [native helper policy](native-helper.md) before you pick deployment defaults, and the [Errors](errors.md) reference so you know what to catch.
- **Replacing ad-hoc atomic writes.** Jump to [Atomic writes](atomic.md) or, for keyed JSON state, [JSON files](json.md).
- **Extracting an upload.** Start at [Archive extraction](archive.md) — handles ZIP and TAR with traversal, link, count, and byte limits.
- **Running an agent in a sandbox.** [Private temp workspaces](temp.md) plus [secret files](secret-file.md) cover the common scratch-and-credentials shape.
- **Looking up a name.** Use the [reference](errors.md) section in the sidebar — every public function has a page.

## What you get

Browse the [subpath catalogue](install.md#subpath-exports) for entry points and
the [public API inventory](public-api.md) for individual runtime and type exports.

## Status

Currently `0.x` — APIs are stable in shape but may be tightened before `1.0`. The [CHANGELOG](https://github.com/openclaw/fs-safe/blob/main/CHANGELOG.md) tracks visible changes. Issues and PRs at the [GitHub repo](https://github.com/openclaw/fs-safe).

Released under the [MIT license](https://github.com/openclaw/fs-safe/blob/main/LICENSE).
