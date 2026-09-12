# Timing

`withTimeout(promise, timeoutMs, labelOrOptions?)` is a small helper for putting a wall-clock ceiling on an async operation. It rejects with a synthetic timeout error after `timeoutMs` and clears its internal timer when the wrapped promise settles first.

```ts
import { withTimeout } from "@openclaw/fs-safe/advanced";
```

## Signature

```ts
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  labelOrOptions?: string | {
    label?: string;
    message?: string;
    createError?: () => Error;
  },
): Promise<T>;
```

If `timeoutMs` is `0`, negative, `Infinity`, or `NaN`, the helper is a no-op and simply awaits the original promise.

Finite delays above Node's single-timer limit (2,147,483,647 ms, about 24.9 days) are scheduled in bounded intervals without expiring early. The timer is still cleared if the wrapped promise settles first.

## Examples

### Simple ceiling

```ts
import { withTimeout } from "@openclaw/fs-safe/advanced";

const buf = await withTimeout(
  fs.readFile("/srv/big.bin"),
  5_000,
  "read big.bin",
);
```

If the read doesn't resolve within 5 seconds, the returned promise rejects with `Error: read big.bin timed out after 5000ms`. The underlying `fs.readFile` continues until Node finishes it — `withTimeout` does not cancel the wrapped work, only the wait.

### Custom message

```ts
await withTimeout(work(), 5_000, {
  message: "build did not finish in time",
});
```

### Custom error factory

```ts
class BuildTimeout extends Error {}

await withTimeout(work(), 5_000, {
  createError: () => new BuildTimeout("build timeout (5s)"),
});
```

`createError` is called when the timer fires; the returned error is what the promise rejects with. Use this when callers branch on `instanceof` or want a custom `cause`.

## Cancellation

`withTimeout` does **not** abort the wrapped operation when the timer fires — it just stops waiting. If you need real cancellation, the wrapped operation must opt into an `AbortSignal` itself:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 5_000);

try {
  const res = await fetch(url, { signal: controller.signal });
  // ...
} finally {
  clearTimeout(timer);
}
```

For the common "I want a deadline AND cancellation" shape, use `AbortSignal.timeout(ms)` directly — it's the standard library's answer and handles both at once.

## Patterns

### Bound a credential refresh

```ts
const fresh = await withTimeout(
  refreshToken(currentRefresh),
  5_000,
  "refresh oauth token",
);
await writeSecretFileAtomic({ rootDir, filePath, content: JSON.stringify(fresh) });
```

### Compose with archive extraction

```ts
import { extractArchive } from "@openclaw/fs-safe/archive";

await extractArchive({
  archivePath,
  destDir,
  kind: "zip",
  timeoutMs: 30_000,
});
```

`extractArchive` already takes `timeoutMs` and carries its own abort signal/deadline checks — you don't need to wrap it. Reach for `withTimeout` for operations that don't carry their own timeout knob.

### Disable in tests

When unit-testing flaky code, you might want to disable the timeout. Pass `0`:

```ts
await withTimeout(work(), process.env.NODE_ENV === "test" ? 0 : 5_000, "work");
```

Better, gate it from the caller — `withTimeout(p, 0, ...)` returns the promise as-is.

## See also

- [Archive extraction](archive.md) — `extractArchive` already takes `timeoutMs`.
- [File lock](sidecar-lock.md) — retry policy is a different form of bounded waiting.
- [`AbortSignal.timeout`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static) — standard-library cancellation when you need to *abort*, not just *give up*.
