import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FsSafeError, root as openRoot } from "../src/index.js";

type TempLayout = {
  outside: string;
  outsideFile: string;
  root: string;
};

const tempDirs: string[] = [];

const ESCAPING_WRITE_PAYLOADS = [
  "../pwned.txt",
  "../../pwned.txt",
  "nested/../../pwned.txt",
  "nested/../../../pwned.txt",
  "./../pwned.txt",
  "nested/..//../pwned.txt",
] as const;

const LITERAL_SUSPICIOUS_WRITE_PAYLOADS = [
  "nested/%2e%2e/pwned.txt",
  "%2e%2e/pwned.txt",
  "%2e%2e%2fpwned.txt",
  "%252e%252e%252fpwned.txt",
] as const;

const POSIX_LITERAL_SUSPICIOUS_WRITE_PAYLOADS = [
  "nested\\..\\..\\pwned.txt",
  "C:\\Windows\\win.ini",
  "\\\\server\\share\\pwned.txt",
] as const;

const SAFE_REJECTED_SUSPICIOUS_WRITE_PAYLOADS = [
  "..%2fpwned.txt",
  "..%00/pwned.txt",
  "..\\pwned.txt",
] as const;

const ESCAPING_DIRECTORY_PAYLOADS = [
  "..",
  "../",
  "../../",
  "nested/../..",
  "nested/../../outside",
] as const;

const LITERAL_SUSPICIOUS_DIRECTORY_PAYLOADS = ["%2e%2e", "%2e%2e%2f"] as const;

const SAFE_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS = ["..\\"] as const;

const WINDOWS_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS = [
  "C:\\Windows",
  "\\\\server\\share",
] as const;

async function makeTempLayout(prefix: string): Promise<TempLayout> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-root-`));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-outside-`));
  tempDirs.push(root, outside);
  const outsideFile = path.join(outside, "secret.txt");
  await fsp.writeFile(outsideFile, "outside secret");
  return { outside, outsideFile, root };
}

function expectFsSafeCode(error: unknown, codes: readonly string[]): void {
  expect(error).toBeInstanceOf(FsSafeError);
  expect(codes).toContain((error as FsSafeError).code);
}

async function expectNoOutsideWrite(layout: TempLayout, expected = "outside secret"): Promise<void> {
  await expect(fsp.readFile(layout.outsideFile, "utf8")).resolves.toBe(expected);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { force: true, recursive: true })));
});

describe("OpenClaw write/move/delete bypass parity", () => {
  it("rejects payload corpus write/create/append/openWritable attempts without touching outside files", async () => {
    const layout = await makeTempLayout("fs-safe-write-payloads");
    await fsp.mkdir(path.join(layout.root, "nested"), { recursive: true });
    const safeRoot = await openRoot(layout.root);

    for (const payload of ESCAPING_WRITE_PAYLOADS) {
      await expect(safeRoot.write(payload, "pwned"), `write(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.create(payload, "pwned"), `create(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.append(payload, "pwned"), `append(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.openWritable(payload), `openWritable(${payload})`).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
  });

  it("rejects payload corpus mkdir and remove attempts", async () => {
    const layout = await makeTempLayout("fs-safe-dir-payloads");
    await fsp.mkdir(path.join(layout.root, "nested"), { recursive: true });
    const safeRoot = await openRoot(layout.root);

    for (const payload of ESCAPING_DIRECTORY_PAYLOADS) {
      await expect(safeRoot.mkdir(payload), `mkdir(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.remove(payload), `remove(${payload})`).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
  });

  it("rejects absolute outside write/create/append/openWritable/copy destinations", async () => {
    const layout = await makeTempLayout("fs-safe-write-absolute");
    const safeRoot = await openRoot(layout.root);
    const source = path.join(layout.root, "source.txt");
    await fsp.writeFile(source, "source");

    await expect(safeRoot.write(layout.outsideFile, "pwned")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "invalid-path"]);
      return true;
    });
    await expect(safeRoot.create(layout.outsideFile, "pwned")).rejects.toBeTruthy();
    await expect(safeRoot.append(layout.outsideFile, "pwned")).rejects.toBeTruthy();
    await expect(safeRoot.openWritable(layout.outsideFile)).rejects.toBeTruthy();
    await expect(safeRoot.copyIn(layout.outsideFile, source)).rejects.toBeTruthy();
    await expectNoOutsideWrite(layout);
  });

  it("rejects symlink parent write/create/append/openWritable/copy/mkdir/remove destinations", async () => {
    const layout = await makeTempLayout("fs-safe-write-symlink-parent");
    await fsp.symlink(layout.outside, path.join(layout.root, "link"), "dir");
    const safeRoot = await openRoot(layout.root);
    const source = path.join(layout.root, "source.txt");
    await fsp.writeFile(source, "source");

    for (const action of [
      () => safeRoot.write("link/secret.txt", "pwned"),
      () => safeRoot.create("link/secret.txt", "pwned"),
      () => safeRoot.append("link/secret.txt", "pwned"),
      () => safeRoot.openWritable("link/secret.txt"),
      () => safeRoot.copyIn("link/secret.txt", source),
      () => safeRoot.mkdir("link/nested"),
      () => safeRoot.remove("link/secret.txt"),
    ]) {
      await expect(action()).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
  });

  it("rejects final symlink leaf write/append/openWritable/copy targets without clobbering their target", async () => {
    const layout = await makeTempLayout("fs-safe-write-symlink-leaf");
    await fsp.symlink(layout.outsideFile, path.join(layout.root, "link.txt"), "file");
    const source = path.join(layout.root, "source.txt");
    await fsp.writeFile(source, "source");
    const safeRoot = await openRoot(layout.root);

    for (const action of [
      () => safeRoot.write("link.txt", "pwned"),
      () => safeRoot.append("link.txt", "pwned"),
      () => safeRoot.openWritable("link.txt"),
      () => safeRoot.copyIn("link.txt", source),
    ]) {
      await expect(action()).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
  });

  it("rejects hardlinked write and append targets", async () => {
    const layout = await makeTempLayout("fs-safe-write-hardlink");
    const source = path.join(layout.root, "source.txt");
    const hardlink = path.join(layout.root, "hardlink.txt");
    await fsp.writeFile(source, "shared");
    await fsp.link(source, hardlink);
    const safeRoot = await openRoot(layout.root);

    await expect(safeRoot.write("hardlink.txt", "pwned")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["hardlink", "invalid-path", "path-alias"]);
      return true;
    });
    await expect(safeRoot.append("hardlink.txt", "pwned")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["hardlink", "invalid-path", "path-alias"]);
      return true;
    });
  });

  it("rejects move payloads for escaping sources and destinations", async () => {
    const layout = await makeTempLayout("fs-safe-move-payloads");
    await fsp.writeFile(path.join(layout.root, "from.txt"), "from");
    const safeRoot = await openRoot(layout.root);

    for (const payload of ESCAPING_WRITE_PAYLOADS) {
      await expect(safeRoot.move(payload, "to.txt"), `move-from(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.move("from.txt", payload), `move-to(${payload})`).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
    await expect(fsp.readFile(path.join(layout.root, "from.txt"), "utf8")).resolves.toBe("from");
  });

  it("rejects symlink move source and destination endpoints without touching outside targets", async () => {
    const layout = await makeTempLayout("fs-safe-move-symlink");
    await fsp.writeFile(path.join(layout.root, "from.txt"), "from");
    await fsp.symlink(layout.outsideFile, path.join(layout.root, "source-link.txt"), "file");
    await fsp.symlink(layout.outsideFile, path.join(layout.root, "dest-link.txt"), "file");
    const safeRoot = await openRoot(layout.root);

    await expect(safeRoot.move("source-link.txt", "moved.txt")).rejects.toBeTruthy();
    await safeRoot.move("from.txt", "dest-link.txt", { overwrite: true });
    await expectNoOutsideWrite(layout);
    await expect(fsp.readFile(path.join(layout.root, "dest-link.txt"), "utf8")).resolves.toBe("from");
  });

  it("rejects remove through symlink parents but removes final symlink entries without following", async () => {
    const layout = await makeTempLayout("fs-safe-remove-symlink");
    await fsp.symlink(layout.outside, path.join(layout.root, "parent-link"), "dir");
    await fsp.symlink(layout.outsideFile, path.join(layout.root, "leaf-link.txt"), "file");
    const safeRoot = await openRoot(layout.root);

    await expect(safeRoot.remove("parent-link/secret.txt")).rejects.toBeTruthy();
    await safeRoot.remove("leaf-link.txt");
    await expect(fsp.lstat(path.join(layout.root, "leaf-link.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoOutsideWrite(layout);
  });

  it("keeps encoded, backslash, Windows, and UNC-looking write payloads literal and inside root", async () => {
    const layout = await makeTempLayout("fs-safe-write-encoded-literal");
    const safeRoot = await openRoot(layout.root);

    const literalWritePayloads = process.platform === "win32"
      ? LITERAL_SUSPICIOUS_WRITE_PAYLOADS
      : [...LITERAL_SUSPICIOUS_WRITE_PAYLOADS, ...POSIX_LITERAL_SUSPICIOUS_WRITE_PAYLOADS];
    for (const payload of literalWritePayloads) {
      await safeRoot.write(payload, "literal");
      await expect(safeRoot.readText(payload), `read literal ${payload}`).resolves.toBe("literal");
    }
    if (process.platform === "win32") {
      for (const payload of POSIX_LITERAL_SUSPICIOUS_WRITE_PAYLOADS) {
        await expect(safeRoot.write(payload, "rejected"), `write safely rejects ${payload}`).rejects.toBeTruthy();
      }
    }
    for (const payload of SAFE_REJECTED_SUSPICIOUS_WRITE_PAYLOADS) {
      await expect(safeRoot.write(payload, "rejected"), `write safely rejects ${payload}`).rejects.toBeTruthy();
    }
    for (const payload of SAFE_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS) {
      await expect(safeRoot.mkdir(payload), `mkdir safely rejects ${payload}`).rejects.toBeTruthy();
    }
    if (process.platform === "win32") {
      for (const payload of WINDOWS_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS) {
        await expect(safeRoot.mkdir(payload), `mkdir safely rejects ${payload}`).rejects.toBeTruthy();
      }
    } else {
      for (const payload of WINDOWS_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS) {
        await safeRoot.mkdir(payload);
        await expect(fsp.stat(path.join(layout.root, payload)), `created literal ${payload}`).resolves.toSatisfy((stat) =>
          stat.isDirectory()
        );
      }
    }
    for (const payload of LITERAL_SUSPICIOUS_DIRECTORY_PAYLOADS) {
      await safeRoot.mkdir(payload);
      await expect(safeRoot.list(payload), `list literal ${payload}`).resolves.toBeInstanceOf(Array);
    }
    await expectNoOutsideWrite(layout);
  });
});
