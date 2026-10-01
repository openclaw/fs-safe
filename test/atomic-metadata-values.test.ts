import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { replaceFileAtomicSync } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it.each(["rename", "refusal", "copy-fallback"] as const)(
  "preserves synchronous metadata values and adapter receivers during %s", async route => {
    const directory = await tempRoot("fs-safe-atomic-metadata-values-");
    const filePath = path.join(directory, "target");
    fs.writeFileSync(filePath, "original", { mode: 0o600 });
    let thenReads = 0, metadataReads = 0;
    const ordinary = <T extends fs.Stats | fs.BigIntStats>(stat: T): T => {
      metadataReads++;
      Object.defineProperty(stat, "then", {
        get() {
          thenReads++;
          throw new Error("synchronous metadata is not a promise");
        },
      });
      return stat;
    };
    const fileSystem = { ...fs };
    fileSystem.lstatSync = function (this: typeof fileSystem, ...args: Parameters<typeof fs.lstatSync>) {
      expect(this).toBe(fileSystem);
      const stat = fs.lstatSync(...args);
      return stat === undefined ? undefined : ordinary(stat);
    } as typeof fs.lstatSync;
    fileSystem.fstatSync = function (this: typeof fileSystem, ...args: Parameters<typeof fs.fstatSync>) {
      expect(this).toBe(fileSystem);
      return ordinary(fs.fstatSync(...args));
    } as typeof fs.fstatSync;
    if (route === "copy-fallback") {
      fileSystem.renameSync = () => { throw Object.assign(new Error("rename denied"), { code: "EPERM" }); };
    }
    const refusal = new Error("publication refused");
    const replace = () => replaceFileAtomicSync({
      filePath, content: "replacement", fileSystem,
      copyFallbackOnPermissionError: true, destinationHardlinks: "reject",
      assertBeforeMutation() {},
      beforeRename() { if (route === "refusal") throw refusal; },
    });
    if (route === "refusal") expect(replace).toThrow(refusal);
    else expect(replace()).toEqual({ method: route });
    expect(metadataReads).toBeGreaterThan(0);
    expect(thenReads).toBe(0);
    expect(fs.readdirSync(directory)).toEqual(["target"]);
    expect(fs.readFileSync(filePath, "utf8")).toBe(route === "refusal" ? "original" : "replacement");
  },
);
