# Filenames

`sanitizeUntrustedFileName(name, fallback)` reduces a filename string from an untrusted source to one portable path segment. Use it as a thin first pass before storing user-supplied names; pair with [`safeDirName`](install-path.md#safedirname) when you need stricter directory-name handling.

```ts
import { sanitizeUntrustedFileName } from "@openclaw/fs-safe";

const safe = sanitizeUntrustedFileName(req.body.fileName, "upload");
await fs.write(`uploads/${safe}`, body);
```

## Signature

```ts
function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string;
```

## What it does

In order:

1. **Trim** whitespace. If the result is empty, return `fallbackName`.
2. **Strip path components.** Apply `path.posix.basename` then `path.win32.basename` so neither `foo/bar.txt` nor `foo\bar.txt` survives — only the final segment remains.
3. **Strip non-portable characters.** C0/C1 controls (`0x00`–`0x1f`, `0x7f`–`0x9f`) and the Windows-invalid set `< > : " / \\ | ? *` are removed on every platform.
4. **Trim again.**
5. If the result is empty, `"."`, or `".."`, return `fallbackName`.
6. **Suffix Windows reserved basenames.** Compare the part before the first `.` case-insensitively with the Windows device-name set, including `CON`, `PRN`, `AUX`, `NUL`, `CLOCK$`, `CONIN$`, `CONOUT$`, `COM1..9`, `LPT1..9`, and their superscript `¹`, `²`, and `³` variants. A match gains `_` before its extension, preserving the original case and extension on every platform.
7. **Truncate.** If the cleaned segment is longer than 200 characters, take the first 200.

That's it. The function stays intentionally small: it produces one traversal-free segment whose characters work across the common POSIX and Windows filename surfaces.

## Examples

```ts
sanitizeUntrustedFileName("notes.txt", "untitled");        // "notes.txt"
sanitizeUntrustedFileName("../../etc/passwd", "upload");   // "passwd"
sanitizeUntrustedFileName("foo\\bar.png", "upload");       // "bar.png"
sanitizeUntrustedFileName("a\u0000b\tc", "upload");       // "abc"
sanitizeUntrustedFileName("   ", "fallback");              // "fallback"
sanitizeUntrustedFileName(".", "fallback");                // "fallback"
sanitizeUntrustedFileName("..", "fallback");               // "fallback"
sanitizeUntrustedFileName("CON", "fallback");              // "CON_"
sanitizeUntrustedFileName("nul.txt", "fallback");          // "nul_.txt"
sanitizeUntrustedFileName("aux.c", "fallback");            // "aux_.c"
sanitizeUntrustedFileName("conin$", "fallback");           // "conin$_"
sanitizeUntrustedFileName("a".repeat(300), "x");          // 200-char "aaa..."
```

## What it does **not** do

The function is deliberately narrow. It will not:

- Replace leading dots (so a name like `.config` stays hidden on POSIX systems).
- Trim trailing dots or spaces (Windows tolerates them silently).
- Add an extension or change case.
- Validate file *content*. To enforce an extension allow-list, check after sanitization.
- Deduplicate against existing files. Append a random suffix if you need uniqueness.

Windows reserved basenames are handled by the default portability pass; callers no longer need to layer a separate reserved-name recipe on top.

## Common patterns

### Make a unique filename

```ts
import { sanitizeUntrustedFileName } from "@openclaw/fs-safe";
import { randomUUID } from "node:crypto";

const base = sanitizeUntrustedFileName(req.body.fileName, "upload");
const unique = `${randomUUID()}-${base}`;
await fs.write(`uploads/${unique}`, body);
```

### Restrict to a known set of extensions

```ts
const safe = sanitizeUntrustedFileName(req.body.fileName, "upload");
const ext = path.extname(safe).toLowerCase();
if (![".png", ".jpg", ".webp"].includes(ext)) return reply(400, "unsupported extension");
```

### Sanitize, then write through a `Root`

```ts
const safe = sanitizeUntrustedFileName(req.body.fileName, "upload");
await fs.write(`uploads/${safe}`, body); // fs is a Root() handle; rejects traversal too
```

## See also

- [Install path helpers](install-path.md) — `safeDirName`, `safePathSegmentHashed` for directory-segment sanitization.
- [`root()`](root.md) — the boundary you'll write into after sanitizing.
