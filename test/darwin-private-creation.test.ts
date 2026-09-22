import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectory, createDirectorySync, createFileHandle, createFileSync } from "../src/create.js";
import { assertPrivateDirectorySync } from "../src/creation-boundary.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
if (process.platform === "darwin") {
  try { native = __loadBundledNativeForTest(); }
  catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
}
const fixtureAcls = new Set<string>();
const acl = (target: string, entry: string) => {
  execFileSync("/bin/chmod", ["+a", entry, target]);
  fixtureAcls.add(target);
};
const inheritable = "everyone allow read,execute,file_inherit,directory_inherit";
const verbs = ["directory", "directory-sync", "file", "file-async", "root-directory", "root-file", "root-json", "root-stream"] as const;
type Verb = typeof verbs[number];
async function create(directory: string, verb: Verb, assertion?: () => void) {
  const options = { private: true, assertBeforeMutation: assertion };
  const target = path.join(directory, "value");
  if (verb === "directory") return await createDirectory(target, options);
  if (verb === "directory-sync") return createDirectorySync(target, options);
  if (verb === "file") return createFileSync(target, options).close();
  if (verb === "file-async") return await (await createFileHandle(target, options)).close();
  const scoped = await root(directory);
  if (verb === "root-directory") return await scoped.mkdir("nested/child", options);
  if (verb === "root-json") return await scoped.createJson("nested/value", { private: true }, options);
  if (verb === "root-stream") {
    async function* bytes() { yield Buffer.from("private content"); }
    return await scoped.create("nested/value", bytes(), options);
  }
  return await scoped.create("nested/value", "private content", { ...options, atomic: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const target of fixtureAcls) if (fs.existsSync(target)) execFileSync("/bin/chmod", ["-N", target]);
  fixtureAcls.clear();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.runIf(process.platform === "darwin")("Darwin private creation admission", () => {
  it.each(["off", "missing-addon", "missing-inspector"] as const)(
    "rejects %s before parents, stages, or mutation callbacks", async missing => {
      configureFsSafeNative({ mode: missing === "off" ? "off" : "auto" });
      __setNativeLoaderForTest(() => {
        if (missing === "missing-inspector") return { ...native, inspectDarwinAcl: undefined } as NativeBinding;
        throw new Error("native addon unavailable");
      });
      const directory = await tempRoot("fs-safe-darwin-private-unavailable-");
      const assertion = vi.fn();
      for (const verb of verbs) {
        await expect(create(directory, verb, assertion)).rejects.toMatchObject({ code: "helper-unavailable" });
        expect(fs.readdirSync(directory)).toEqual([]);
      }
      expect(assertion).not.toHaveBeenCalled();
      createDirectorySync(path.join(directory, "ordinary"));
      createFileSync(path.join(directory, "ordinary-file")).close();
      expect(fs.readdirSync(directory).sort()).toEqual(["ordinary", "ordinary-file"]);
    },
  );
});

describe.runIf(process.platform === "darwin" && typeof native?.inspectDarwinAcl === "function")("Darwin private ACL policy", () => {
  it.each(verbs)("refuses inherited broad ACLs before %s creation", async verb => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-private-inherit-");
    acl(directory, inheritable);
    await expect(create(directory, verb)).rejects.toMatchObject({ code: "insecure-permissions" });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("demonstrates mode 000 ACL override while refusing the private counterpart", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-private-zero-");
    const inherited = path.join(directory, "inherited");
    fs.mkdirSync(inherited);
    acl(inherited, inheritable);
    const ordinary = path.join(inherited, "ordinary");
    const fd = fs.openSync(ordinary, "wx+", 0);
    try { fs.writeFileSync(fd, "synthetic ACL override"); } finally { fs.closeSync(fd); }
    expect(fs.statSync(ordinary).mode & 0o777).toBe(0);
    expect(fs.readFileSync(ordinary, "utf8")).toBe("synthetic ACL override");
    expect(() => createFileSync(path.join(inherited, "private"), { private: true, mode: 0 }))
      .toThrow(expect.objectContaining({ code: "insecure-permissions" }));
    const plain = createFileSync(path.join(directory, "plain"), { private: true, mode: 0 });
    try {
      expect(native!.inspectDarwinAcl!(plain.fd).state).not.toBe("present");
      expect(fs.fstatSync(plain.fd).mode & 0o777).toBe(0);
    } finally { plain.close(); }
    if (process.getuid?.() !== 0) expect(() => fs.readFileSync(path.join(directory, "plain")))
      .toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(fs.readdirSync(inherited)).toEqual(["ordinary"]);
  });

  it("allows noninheriting parent ACLs without broadening restrictive directory modes", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-private-parent-acl-");
    acl(directory, "everyone deny delete");
    const before = execFileSync("/bin/ls", ["-lde", directory], { encoding: "utf8" }).split("\n").slice(1);
    for (const mode of [0o100, 0o300, 0o400]) {
      const target = path.join(directory, mode.toString(8));
      try {
        createDirectorySync(target, { private: true, mode });
        assertPrivateDirectorySync(target);
        expect(fs.statSync(target).mode & 0o777).toBe(mode);
      } finally { if (fs.existsSync(target)) fs.chmodSync(target, 0o700); }
    }
    createFileSync(path.join(directory, "file"), { private: true }).close();
    expect(execFileSync("/bin/ls", ["-lde", directory], { encoding: "utf8" }).split("\n").slice(1)).toEqual(before);
  });

  it.each([0, 0o200])("rejects unattestable private directory mode %i before creation and preserves existing modes", async mode => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-private-directory-mode-");
    const target = path.join(directory, "target");
    expect(() => createDirectorySync(target, { private: true, mode }))
      .toThrow(expect.objectContaining({ code: "helper-unavailable" }));
    await expect(createDirectory(target, { private: true, mode }))
      .rejects.toMatchObject({ code: "helper-unavailable" });
    expect(fs.readdirSync(directory)).toEqual([]);
    fs.mkdirSync(target, { mode });
    try {
      expect(() => assertPrivateDirectorySync(target)).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
      expect(fs.statSync(target).mode & 0o777).toBe(mode);
    } finally { fs.chmodSync(target, 0o700); }
  });

  it("rejects ACL-bearing existing private directories without altering the ACL", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-private-existing-");
    const child = path.join(directory, "child");
    fs.mkdirSync(child, { mode: 0o700 });
    acl(child, "everyone allow read,execute");
    const before = execFileSync("/bin/ls", ["-lde", child], { encoding: "utf8" });
    const scoped = await root(directory);
    await expect(scoped.mkdir("child", { private: true })).rejects.toMatchObject({ code: "insecure-permissions" });
    expect(execFileSync("/bin/ls", ["-lde", child], { encoding: "utf8" })).toBe(before);
  });

  it.each(["directory-sync", "file", "file-async"] as const)("rechecks parent ACL after the %s mutation callback", async verb => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-private-callback-");
    await expect(create(directory, verb, () => acl(directory, inheritable)))
      .rejects.toMatchObject({ code: "insecure-permissions" });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("keeps older or malformed inspectors conservative", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-private-old-helper-");
    acl(directory, "everyone deny delete");
    __setNativeLoaderForTest(() => ({ ...native!, inspectDarwinAcl: fd => native!.inspectDarwinAcl!(fd) }));
    expect(() => createFileSync(path.join(directory, "old"), { private: true }))
      .toThrow(expect.objectContaining({ code: "insecure-permissions" }));
    __setNativeLoaderForTest(() => ({ ...native!, inspectDarwinAcl: () => ({ state: "unknown" }) as never }));
    expect(() => createFileSync(path.join(directory, "malformed"), { private: true }))
      .toThrow(expect.objectContaining({ code: "helper-unavailable" }));
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("inspects native stage ACLs before any payload write", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-private-stage-acl-");
    let removedBytes: number | undefined;
    __setNativeLoaderForTest(() => ({
      ...native!,
      createStagedFile(parent, name) {
        const fd = native!.createStagedFile!(parent, name);
        acl(path.join(directory, name), "everyone allow read");
        return fd;
      },
      removeStagedFile(parent, name, fd) {
        removedBytes = fs.fstatSync(fd).size;
        return native!.removeStagedFile!(parent, name, fd);
      },
    }));
    const scoped = await root(directory);
    await expect(scoped.create("target", "must remain unwritten", { private: true, atomic: true }))
      .rejects.toMatchObject({ code: "insecure-permissions" });
    expect(removedBytes).toBe(0);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each([false, true])("checks ACLs after the final native mutation callback (atomic=%s)", async atomic => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-private-publication-acl-");
    const scoped = await root(directory);
    const data = "complete synthetic payload";
    let changed = false;
    const error = await scoped.create("target", data, {
      private: true, atomic, durable: false,
      assertBeforeMutation() {
        if (changed) return;
        const leaf = fs.readdirSync(directory).find(name => fs.statSync(path.join(directory, name)).size === Buffer.byteLength(data));
        if (leaf) { acl(path.join(directory, leaf), "everyone allow read"); changed = true; }
      },
    }).catch((reason: unknown) => reason);
    expect(changed).toBe(true);
    const reasons: unknown[] = [];
    for (let reason = error; reason instanceof Error; reason = reason.cause) reasons.push(reason);
    expect(reasons).toContainEqual(expect.objectContaining({ code: "insecure-permissions" }));
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
