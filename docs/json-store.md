# JSON store

`jsonStore` is exported from `@openclaw/fs-safe/store`. It is the absolute-path
convenience wrapper for `fileStore(...).json(...)`: a small read-modify-write
handle around a single JSON file. It bakes in atomic writes, explicit fallback
reads, and optional cross-process locking via
[`acquireFileLock`](sidecar-lock.md).

```ts
import { jsonStore } from "@openclaw/fs-safe/store";

const settings = jsonStore<{ theme: "light" | "dark"; volume: number }>({
  filePath: "/var/lib/app/settings.json",
});

const current = await settings.readOr({ theme: "dark", volume: 0.7 });
await settings.write({ ...current, volume: 1 });
await settings.updateOr({ theme: "dark", volume: 0.7 }, (prev) => ({ ...prev, theme: "light" }));
```

If you already have a store/root context, prefer binding the JSON file from that
store:

```ts
import { fileStore } from "@openclaw/fs-safe/store";

const files = fileStore({ rootDir: "/var/lib/app", private: true });
const settings = files.json<Settings>("settings.json", { lock: true });
```

## When to reach for it

- You have a single JSON state file and want `read / readOr / readRequired / write / update` semantics.
- You want every write atomic at file mode `0o600` and parents at `0o700` by default.
- You want optional cross-process locking with one boolean.

For ad-hoc read/write of multiple JSON files, use the standalone helpers in
[`json`](json.md). For object-style storage of many files at known modes, use
[`fileStore`](file-store.md) and bind JSON files with `store.json(rel)`.

## Factory: `jsonStore<T>(options)`

```ts
type JsonStoreOptions<T> = {
  filePath: string;
  dirMode?: number;                                // default 0o700
  mode?: number;                                   // default 0o600
  trailingNewline?: boolean;                       // default true
  lock?: boolean | JsonStoreLockOptions;           // false / undefined = no lock
};

type JsonStoreLockOptions = {
  staleMs?: number;     // default 30_000
  timeoutMs?: number;   // default 30_000
  retry?: FileLockRetryOptions;
  staleRecovery?: "fail-closed" | "remove-if-unchanged";
  managerKey?: string;  // default `fs-safe.json-store:<filePath>`
};

type JsonStore<T> = {
  readonly filePath: string;
  read(): Promise<T | undefined>;
  readOr(fallback: T): Promise<T>;
  readRequired(): Promise<T>;
  write(value: T): Promise<void>;
  update(run: (current: T | undefined) => T | Promise<T>): Promise<T>;
  updateOr(fallback: T, run: (current: T) => T | Promise<T>): Promise<T>;
};
```

`jsonStore({ filePath })` resolves `rootDir = dirname(filePath)` and calls
`fileStore({ rootDir, private: true }).json(basename(filePath), options)`.

The store does **not** validate the parsed value against `T` at runtime — the cast is unchecked. Wrap with a schema (zod/valibot) if the file might be hand-edited or written by another process you don't control.

## `read()`

Returns the parsed contents, or `undefined` if the file does not exist. Invalid JSON throws (via [`readJsonIfExists`](json.md)).

```ts
const state = await store.read();
```

## `readOr(fallback)`

Returns the parsed contents or the per-call fallback. Object fallbacks are cloned so callers can safely mutate the returned value:

```ts
const state = await store.readOr(defaultState);
```

## `readRequired()`

Strict disk read. Throws when the file is missing or invalid:

```ts
const state = await store.readRequired();
```

## `write(value)`

Atomic JSON write at `mode` (default `0o600`), creating parent dirs at `dirMode` (default `0o700`) if needed. When `lock: true` is set, takes the sidecar lock for the duration of the write.

```ts
await store.write({ ...state, lastSeen: Date.now() });
```

## `update(run)`

Read, transform, write — under the lock if locking is enabled. Returns the new value:

```ts
const next = await store.update((prev) => ({ count: (prev?.count ?? 0) + 1 }));
```

`run` is async-friendly. The whole `read → run → write` sequence is serialized
by canonical file path inside the process. With locking enabled, the sidecar
lock is acquired inside that queue, so concurrent updaters from different
processes serialize cleanly too.

Do not call `write()`, `update()`, or `updateOr()` for the same file from inside
an update callback. That nested mutation cannot run until the outer update
finishes, so `jsonStore` rejects it immediately with
`FsSafeError("store-reentrant-update")`. Return the complete next value from the
outer callback instead. The check follows Node async context, including promise
and `queueMicrotask` boundaries.

Use `update(run)` when missing state is part of your model. Use `updateOr(fallback, run)` when the missing-file case should start from a concrete value and you want to merge into defaults:

```ts
const next = await store.updateOr({ count: 0 }, (prev) => ({ count: prev.count + 1 }));
```

## Locking

Set `lock: true` for default behavior, or pass an options object to tune:

```ts
const counter = jsonStore<{ count: number }>({
  filePath: "/var/lib/app/counter.json",
  lock: {
    staleMs: 60_000,
    timeoutMs: 10_000,
    staleRecovery: "fail-closed",
    retry: { retries: 30, minTimeout: 100, maxTimeout: 5_000, randomize: true },
  },
});
```

When `lock` is falsy, writes and updates still serialize inside this process by
canonical file path, including across separate `jsonStore` handles. They offer
no concurrency guarantees if another process also writes to the file.

Process-wide lock defaults from `configureFsSafeLocks()` apply only after locking is explicitly enabled. They do not make JSON stores lock by default.

JSON store locks fail closed on stale sidecars by default. Opt-in `staleRecovery: "remove-if-unchanged"` requires caller approval and uses the same exclusive reclaim guard as the low-level sidecar-lock API.

The default `managerKey` namespaces the `FileLockManager` per absolute file
path. The JSON-store queue is independent of the manager key, so separate
handles and custom lock-manager namespaces still cannot overlap mutations of
the same canonical file path inside one process.

## Common patterns

### Per-feature settings file

```ts
type Settings = { theme: "light" | "dark"; muted: boolean };

const settings = jsonStore<Settings>({
  filePath: path.join(homedir(), ".myapp/settings.json"),
});

// Read on boot
applySettings(await settings.readOr({ theme: "dark", muted: false }));

// Toggle on UI action
await settings.update((prev) => {
  const current = prev ?? { theme: "dark", muted: false };
  return { ...current, muted: !current.muted };
});
```

### Cross-process counter

```ts
const counter = jsonStore<{ count: number }>({
  filePath: "/var/lib/app/counter.json",
  lock: true,
});

const { count } = await counter.updateOr({ count: 0 }, (prev) => ({ count: prev.count + 1 }));
console.log("now at", count);
```

### Migration on boot

```ts
const config = jsonStore<Config>({ filePath });
const current = await config.readOr(defaultConfig);
if (current.version !== CURRENT_VERSION) {
  await config.write(migrate(current));
}
```

## Difference from raw `writeJson` / `readJsonIfExists`

| `jsonStore` | Raw helpers |
|---|---|
| Read-modify-write in one call (`update`). | Compose `readJsonIfExists` + `writeJson` yourself. |
| Optional cross-process lock with one flag. | Manage `withFileLock` yourself. |
| Explicit `readOr` / `updateOr` fallbacks. | Caller handles `null` and clones. |
| Mode/dirMode locked per store. | Per-call. |

`jsonStore` is the right shape when one file owns one piece of state and many call sites read or update it. For one-off writes, the raw helpers are leaner.

## See also

- [JSON files](json.md) — the standalone helpers `jsonStore` is built on.
- [File lock](sidecar-lock.md) — the cross-process lock used when `lock: true`.
- [File store](file-store.md) — the multi-file equivalent of this surface.
