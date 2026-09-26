import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const consumer = resolve(process.argv[2] ?? ".");
const require = createRequire(import.meta.url);
const compilerPackage = require.resolve("typescript/package.json");
const compiler = JSON.parse(readFileSync(compilerPackage, "utf8"));
const probe = join(consumer, "directory-receipt-consumer.ts");
const output = join(consumer, "directory-receipt-build");
const config = join(consumer, "directory-receipt-tsconfig.json");

writeFileSync(probe, `
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, realpathSync, rmSync, utimesSync, type BigIntStats, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Root, RootWalkDataEntryKind, RootWalkEntry, RootWalkOptions, RootWalkSymlinkPolicy,
} from "@openclaw/fs-safe";
import { stageFileInDirectory } from "@openclaw/fs-safe/advanced";
import {
  pinDirectory,
  publishFileExclusive,
  syncDirectory,
  syncDirectorySync,
  type DirectoryReceipt,
  type DirectorySyncOutcome,
} from "@openclaw/fs-safe/durability";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type WalkItem<T> = T extends AsyncIterable<infer Entry> ? Entry : never;
type LegacyKinds = Expect<Equal<RootWalkDataEntryKind, "file" | "directory" | "other">>;
type LegacyPolicies = Expect<Equal<RootWalkOptions["symlinkPolicy"], "skip" | "follow-within-root">>;

export function rootWalkDeclarations(
  scoped: Root,
  legacyOptions: RootWalkOptions,
  includeOptions: RootWalkOptions<"include">,
  dynamicOptions: RootWalkOptions<RootWalkSymlinkPolicy>,
) {
  const legacy: AsyncIterableIterator<RootWalkEntry> = scoped.walk("", legacyOptions);
  const skipped = scoped.walk("", { symlinkPolicy: "skip" });
  const followed = scoped.walk("", { symlinkPolicy: "follow-within-root" });
  const included = scoped.walk("", {
    symlinkPolicy: "include",
    entryFilter(entry) {
      return entry.kind === "symlink" ? "skip" : "include";
    },
  });
  const annotated: AsyncIterableIterator<RootWalkEntry<"include">> = scoped.walk("", includeOptions);
  const dynamic: AsyncIterableIterator<RootWalkEntry<"include">> = scoped.walk("", dynamicOptions);
  type SkipResult = Expect<Equal<WalkItem<typeof skipped>, RootWalkEntry>>;
  type FollowResult = Expect<Equal<WalkItem<typeof followed>, RootWalkEntry>>;
  type IncludeResult = Expect<Equal<WalkItem<typeof included>, RootWalkEntry<"include">>>;
  return { legacy, skipped, followed, included, annotated, dynamic };
}

// Type-check the remaining input sites without requiring native staging support.
export function remainingReceiptInputs(receipt: DirectoryReceipt<BigIntStats>) {
  return {
    sync: () => syncDirectory(receipt),
    publish: (sourcePath: string, targetPath: string) => publishFileExclusive({
      sourcePath,
      targetPath,
      strategy: "link-required",
      parentReceipt: receipt,
    }),
    stage: () => stageFileInDirectory({ directory: receipt, content: "payload" }),
  };
}

function assertSyncOutcome(outcome: DirectorySyncOutcome) {
  assert.ok(
    outcome.status === "synced" ||
      (process.platform === "win32" && outcome.status === "unsupported"),
  );
}

const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "fs-safe-package-receipt-")));
try {
  utimesSync(directory, 1_700_000_000.123789, 1_700_000_001.456789);
  const numeric = lstatSync(directory);
  const input: DirectoryReceipt<BigIntStats> = {
    path: directory,
    realPath: directory,
    identity: lstatSync(directory, { bigint: true }),
  };
  assertSyncOutcome(syncDirectorySync(input));
  const pinned = await pinDirectory(input);
  try {
    const receipt: DirectoryReceipt = pinned.receipt;
    const metadata: Stats = receipt.identity;
    const numericFields: (keyof Stats)[] = [
      "dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "blksize", "size", "blocks",
      "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs",
    ];
    for (const field of numericFields) {
      assert.equal(typeof metadata[field], "number", field);
    }
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.isFile(), false);
    const dateFields: ("atime" | "mtime" | "ctime" | "birthtime")[] = [
      "atime", "mtime", "ctime", "birthtime",
    ];
    for (const field of dateFields) {
      assert.ok(metadata[field] instanceof Date, field);
      assert.equal(metadata[field].getTime(), numeric[field].getTime(), field);
    }
    await pinned.assertCurrent();
    assertSyncOutcome(syncDirectorySync(receipt));
    assertSyncOutcome(await pinned.sync());
  } finally {
    await pinned.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log("directory receipt installed-package bigint admission and numeric metadata passed");
`);
writeFileSync(config, JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ES2022",
    lib: ["ES2023", "ESNext.Disposable"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    esModuleInterop: true,
    verbatimModuleSyntax: true,
    types: ["node"],
    typeRoots: [dirname(dirname(require.resolve("@types/node/package.json")))],
    outDir: output,
    // Exercise runtime independently even when old declarations reject the input type.
    noEmitOnError: false,
  },
  files: [probe],
}, null, 2));

const failures = [];
for (const [label, args] of [
  ["declarations", [resolve(dirname(compilerPackage), compiler.bin.tsc), "-p", config]],
  ["runtime", [join(output, "directory-receipt-consumer.js")]],
]) {
  try {
    execFileSync(process.execPath, args, { cwd: consumer, stdio: "inherit" });
  } catch (error) {
    failures.push(new Error(`directory receipt package ${label} failed`, { cause: error }));
  }
}
if (failures.length > 0) {
  throw new AggregateError(failures, "directory receipt installed-package proof failed");
}
console.log("Root.walk installed-package declaration compatibility passed");
