import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoOutsideWrite, makeTempLayout } from "./helpers/security.js";
import { useTempDirs } from "./helpers/vitest.js";
import { root as openRoot } from "../src/index.js";

const { tempDirs } = useTempDirs();

const DOT_SEGMENTS = ["..", "...", ". .", ".. ", " ..", "%2e%2e", "%252e%252e"] as const;
const SEPARATORS = ["/", "//", "\\", "\\\\", "%2f", "%5c"] as const;
const TARGETS = ["secret.txt", "etc/passwd", "Windows/win.ini", "CON", "NUL", "aux.txt"] as const;
const CONTROL_PAYLOADS = [
  "..\u0000/secret.txt",
  "..\u0001/secret.txt",
  "..\u001f/secret.txt",
  "safe\u0000name.txt",
  "safe\u202ename.txt",
  "safe\ufeffname.txt",
] as const;

function buildPayloadCorpus(): string[] {
  const payloads = new Set<string>();
  for (const dot of DOT_SEGMENTS) {
    for (const sep of SEPARATORS) {
      for (const target of TARGETS) {
        payloads.add(`${dot}${sep}${target}`);
        payloads.add(`nested${sep}${dot}${sep}${dot}${sep}${target}`);
      }
    }
  }
  payloads.add("/etc/passwd");
  payloads.add("//server/share/secret.txt");
  payloads.add("C:/Windows/win.ini");
  payloads.add("C:\\Windows\\win.ini");
  for (const payload of CONTROL_PAYLOADS) {
    payloads.add(payload);
  }
  return [...payloads];
}

async function closeIfOpened(value: unknown): Promise<void> {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Symbol.asyncDispose in value) {
    await (value as { [Symbol.asyncDispose](): Promise<void> })[Symbol.asyncDispose]();
    return;
  }
  if ("handle" in value) {
    await (value as { handle: { close(): Promise<void> } }).handle.close();
    return;
  }
  if ("close" in value) {
    await (value as { close(): Promise<void> }).close();
  }
}

async function attemptAll(rootDir: Awaited<ReturnType<typeof openRoot>>, payload: string): Promise<void> {
  const opened = await rootDir.open(payload).catch((error: unknown) => error);
  await closeIfOpened(opened);
  const writable = await rootDir.openWritable(payload).catch((error: unknown) => error);
  await closeIfOpened(writable);
  await Promise.allSettled([
    rootDir.read(payload),
    rootDir.stat(payload),
    rootDir.write(payload, "payload"),
    rootDir.create(payload, "payload"),
    rootDir.append(payload, "payload"),
  ]);
}

describe("adversarial boundary payloads", () => {
  it("never reads, writes, or deletes outside the root for a generated traversal corpus", async () => {
    const layout = await makeTempLayout("fs-safe-adversarial-corpus", tempDirs);
    await fsp.mkdir(path.join(layout.root, "nested"), { recursive: true });
    await fsp.mkdir(path.join(layout.root, "safe"), { recursive: true });
    const safeRoot = await openRoot(layout.root);

    const payloads = buildPayloadCorpus().slice(0, 96);
    for (const payload of payloads) {
      await attemptAll(safeRoot, payload);
      await expectNoOutsideWrite(layout);
    }
  }, 30_000);

  it("rejects chained symlink parent escapes across read and write surfaces", async () => {
    const layout = await makeTempLayout("fs-safe-symlink-chain", tempDirs);
    await fsp.mkdir(path.join(layout.root, "a"), { recursive: true });
    await fsp.symlink(path.join(layout.root, "a"), path.join(layout.root, "link-a"), "dir");
    await fsp.symlink(layout.outside, path.join(layout.root, "a", "link-out"), "dir");
    const safeRoot = await openRoot(layout.root);

    for (const payload of ["link-a/link-out/secret.txt", "a/link-out/secret.txt"]) {
      await expect(safeRoot.read(payload), `read ${payload}`).rejects.toBeTruthy();
      await expect(safeRoot.write(payload, "pwned"), `write ${payload}`).rejects.toBeTruthy();
      await expect(safeRoot.remove(payload), `remove ${payload}`).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
  });

  it("does not clobber outside files when copy and move payloads mix source and destination attacks", async () => {
    const layout = await makeTempLayout("fs-safe-copy-move-corpus", tempDirs);
    const source = path.join(layout.root, "source.txt");
    await fsp.writeFile(source, "source");
    await fsp.symlink(layout.outsideFile, path.join(layout.root, "outside-link.txt"), "file");
    const safeRoot = await openRoot(layout.root);
    const payloads = buildPayloadCorpus().slice(0, 48);

    for (const payload of payloads) {
      await Promise.allSettled([
        safeRoot.copyIn(payload, source),
        safeRoot.copyIn("copied.txt", layout.outsideFile),
        safeRoot.move("source.txt", payload, { overwrite: true }),
        safeRoot.move(payload, "moved.txt", { overwrite: true }),
        safeRoot.move("outside-link.txt", "moved-link.txt", { overwrite: true }),
      ]);
      await expectNoOutsideWrite(layout);
      await fsp.writeFile(source, "source");
    }
  }, 30_000);
});
