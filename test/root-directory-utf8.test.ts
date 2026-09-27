import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { root, type Root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const scans: [string, (scoped: Root) => Promise<unknown>][] = [
  ["list names", scoped => scoped.list("")],
  ["list metadata", scoped => scoped.list("", { withFileTypes: true })],
  ...(["filesystem", "sorted"] as const).flatMap(order => [
    [`entries ${order}`, (scoped: Root) => Array.fromAsync(scoped.entries("", { order }))],
    [`bounded entries ${order}`, (scoped: Root) => Array.fromAsync(scoped.entries("", { order, maxEntries: 10 }))],
    [`walk ${order}`, (scoped: Root) => Array.fromAsync(scoped.walk("", { order, symlinkPolicy: "skip" }))],
  ] as [string, (scoped: Root) => Promise<unknown>][]),
];

describe.skipIf(process.platform !== "linux")("Root directory filename decoding", () => {
  it.each(scans)("rejects invalid UTF-8 before %s can alias another entry", async (_name, scan) => {
    const directory = await tempRoot("fs-safe-directory-utf8-");
    const invalid = Buffer.concat([Buffer.from(`${directory}${path.sep}`), Buffer.from([0xff])]);
    await fs.writeFile(invalid, "raw bytes");
    await fs.writeFile(path.join(directory, "\ufffd"), "different file");
    const scoped = await root(directory);

    await expect(scan(scoped)).rejects.toMatchObject({ code: "invalid-path" });
    expect(await fs.readFile(invalid, "utf8")).toBe("raw bytes");
    expect(await fs.readFile(path.join(directory, "\ufffd"), "utf8")).toBe("different file");
  });
});

it.each(["filesystem", "sorted"] as const)("preserves valid Unicode names and metadata (%s)", async order => {
  const directory = await tempRoot("fs-safe-directory-unicode-");
  const names = ["\ufffd", "caf\u00e9", "日本語", "~", "internal space"];
  for (const [index, name] of names.entries()) await fs.writeFile(path.join(directory, name), "x".repeat(index + 1));
  const scoped = await root(directory);
  expect(await scoped.list("")).toEqual([...names].sort());
  const entries = await Array.fromAsync(scoped.entries("", { order, maxEntries: 10 }));
  expect(entries.map(entry => entry.name).sort()).toEqual([...names].sort());
  for (const entry of entries) expect(entry.size).toBe(names.indexOf(entry.name) + 1);
  const walked = await Array.fromAsync(scoped.walk("", { order, symlinkPolicy: "skip" }));
  expect(walked.map(entry => entry.relativePath).sort()).toEqual([...names].sort());
});
