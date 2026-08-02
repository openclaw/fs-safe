# Secret files

Helpers for reading and writing credentials. Files are written at mode `0o600`, dirs at `0o700`, with a maximum read size to avoid OOM on bogus input.

```ts
import {
  createSecretFileAtomic,
  readSecretFile,
  readSecretFileSync,
  tryReadSecretFile,
  tryReadSecretFileSync,
  writeSecretFileAtomic,
  DEFAULT_SECRET_FILE_MAX_BYTES,
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
} from "@openclaw/fs-safe/secret";
```

## When to use these vs `writeJson`

| Use these when | Use `writeJson` when |
|---|---|
| The file is a credential (token, key, password). | The file is application state. |
| You want the parent directory created at `0o700` if missing. | You don't care about the parent directory mode. |
| You want a hard size cap on reads (to defend against bogus input). | You're reading bounded JSON state. |
| Mode `0o600` and the private parent policy are mandatory. | Standalone `writeJson` also defaults to `0o600`, but it does not enforce the secret-directory ownership and permission policy. |

## Constants

```ts
DEFAULT_SECRET_FILE_MAX_BYTES = 16 * 1024;  // 16 KiB
PRIVATE_SECRET_DIR_MODE = 0o700;
PRIVATE_SECRET_FILE_MODE = 0o600;
```

The 16 KiB cap is intentionally aggressive — credentials should be small. If you need bigger, pass `maxBytes` explicitly.

## Reading

### `tryReadSecretFileSync(filePath, label, options?)`

The missing-is-optional reader. It returns the trimmed secret string, or
`undefined` when the `filePath` argument is absent/blank or the target does not
exist. An existing empty file is invalid and throws, as do unreadable,
oversized, symlink, hardlink, and other validation failures.

```ts
import { tryReadSecretFileSync } from "@openclaw/fs-safe/secret";

const token = tryReadSecretFileSync("/var/lib/app/auth.token", "auth token");
if (token) {
  useToken(token);
} else {
  await reauthenticate();
}
```

### `readSecretFileSync(filePath, label, options?)`

Strict reader. Throws `FsSafeError` when the file is missing, too large, empty, unreadable, or rejected by the validation checks. Use when failing loudly is the right call:

```ts
const token = readSecretFileSync("/var/lib/app/auth.token", "auth token");
```

### Read options

```ts
type SecretFileReadOptions = {
  maxBytes?: number;         // default DEFAULT_SECRET_FILE_MAX_BYTES (16 KiB)
  rejectSymlink?: boolean;   // default false
  rejectHardlinks?: boolean; // default true
};
```

The reader trims the file content and rejects empty results. Symlink paths are
followed and pinned by default; set `rejectSymlink: true` when the pathname
itself must not be an alias. Hardlinks are rejected by default so another
in-tree name cannot alias the credential; pass `rejectHardlinks: false` only
when you explicitly trust that layout.

`readSecretFile()` and `tryReadSecretFile()` are asynchronous counterparts with
the same pinned-handle validation, byte cap, trimming, error codes, and strict
versus missing-is-undefined naming semantics.

Use the async strict reader when a service cannot start safely without the
credential:

```ts
import { readSecretFile } from "@openclaw/fs-safe/secret";

const signingKey = await readSecretFile(
  "/var/lib/app/keys/webhook-signing.key",
  "webhook signing key",
  { maxBytes: 8 * 1024, rejectSymlink: true },
);
startWebhookVerifier(signingKey);
```

## Writing

### `writeSecretFileAtomic(params)`

Async. Creates the parent directory at `dirMode` (default `0o700`) if missing, writes content to a sibling temp file at `mode` (default `0o600`), atomically renames over the destination, and re-asserts the file mode after rename.

```ts
import { writeSecretFileAtomic } from "@openclaw/fs-safe/secret";

await writeSecretFileAtomic({
  rootDir: "/var/lib/app",
  filePath: "/var/lib/app/auth.token",
  content: token,
});
```

### Parameters

```ts
type WriteSecretFileParams = {
  rootDir: string;             // trusted root directory (created at dirMode if missing)
  filePath: string;             // absolute path; must be inside rootDir
  content: string | Uint8Array;
  mode?: number;                // file mode for the new file (default PRIVATE_SECRET_FILE_MODE = 0o600)
  dirMode?: number;             // mode for the root and intermediate dirs (default PRIVATE_SECRET_DIR_MODE = 0o700)
};
```

The directory mode is asserted on each component along the path: `rootDir`, then any intermediate dirs, then the parent. The helper enforces that every component matches `dirMode` — wider permissions on an existing directory cause the write to fail. Audit and tighten existing secret directories yourself.

### `createSecretFileAtomic(params)`

This create-only sibling has the same directory, mode, pinned-write, and
post-write verification policy. Final materialization uses exclusive create;
if anything already occupies the target path it throws
`FsSafeError("secret-exists")` without modifying that entry. Use the distinct
name when first-writer-wins is part of the credential protocol.

For example, two onboarding requests may race to install the first refresh
token. Exactly one should win, and the loser must not overwrite it:

```ts
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { createSecretFileAtomic } from "@openclaw/fs-safe/secret";

try {
  await createSecretFileAtomic({
    rootDir: "/var/lib/app/credentials",
    filePath: "/var/lib/app/credentials/provider.refresh-token",
    content: refreshToken,
  });
} catch (error) {
  if (!(error instanceof FsSafeError) || error.code !== "secret-exists") throw error;
  // Another initializer won. Read and validate the installed credential.
}
```

For more permissive credentials, override `mode`:

```ts
await writeSecretFileAtomic({
  rootDir: "/var/lib/app",
  filePath: "/var/lib/app/readonly.token",
  content: token,
  mode: 0o400, // tighter than the default
});
```

## Common patterns

### Load on boot, reauthenticate on miss

```ts
const token = tryReadSecretFileSync("/var/lib/app/auth.token", "auth token");
if (!token) await runOauthFlow();
```

### Refresh and persist a token

```ts
const fresh = await refreshToken(currentRefresh);
await writeSecretFileAtomic({
  rootDir: "/var/lib/app",
  filePath: "/var/lib/app/auth.token",
  content: JSON.stringify(fresh),
});
```

### Compose with `withTimeout`

```ts
import { withTimeout } from "@openclaw/fs-safe/advanced";

await withTimeout(
  writeSecretFileAtomic({ rootDir, filePath, content }),
  5_000,
  "persist auth token",
);
```

## Threat model notes

- These helpers protect the secret file from **other processes with the same UID** that respect filesystem permissions. They do not defend against root or against attackers who can read process memory.
- Validation failures are tripwires, not authorization. Investigate before clearing a rejected credential file.
- If the destination directory is on a tmpfs that does not honor mode bits, the helpers will set the mode bits but the OS may ignore them. Audit your platform.

## See also

- [JSON files](json.md) — `writeJson` accepts `mode: 0o600` for non-secret JSON state.
- [Atomic writes](atomic.md) — the lower-level `replaceFileAtomic` used by these helpers.
- [Private file-store mode](private-file-store.md) — root-bounded JSON+text stores using secret-file write policy.
- [Migrating to 0.5](migrating-to-0.5.md) — strict/try reads and create-only adoption checklist.
