import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { assertPublicApi, inspectPublicApi } from "../scripts/public-api-surface.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const manifest = JSON.parse(readFileSync(new URL("./public-api.json", import.meta.url), "utf8"));

it("accepts the recorded public surface", () => {
  expect(() => assertPublicApi(structuredClone(manifest))).not.toThrow();
});

it("rejects a vanished literal error-code map even when its type remains exported", () => {
  const actual = structuredClone(manifest);
  delete actual.packageSubpaths["."].errorCodes.FsSafeErrorCode;
  expect(actual.packageSubpaths["."].types).toContain("FsSafeErrorCode");
  expect(() => assertPublicApi(actual)).toThrow("error-code type vanished from .: FsSafeErrorCode");
});

it("rejects newly recorded literal error-code types", () => {
  const actual = structuredClone(manifest);
  actual.packageSubpaths["."].errorCodes.AdditionalErrorCode = ["added"];
  expect(() => assertPublicApi(actual)).toThrow("error-code type appeared at .: AdditionalErrorCode");
});

it("detects a real declaration widened from a literal union to string", async () => {
  const consumer = await tempRoot("fs-safe-api-surface-");
  const installed = path.join(consumer, "node_modules", "@openclaw", "fs-safe");
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}');
  await fs.writeFile(path.join(installed, "package.json"), JSON.stringify({
    name: "@openclaw/fs-safe", type: "module",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
  }));
  await fs.writeFile(path.join(installed, "index.js"), "export {};\n");
  await fs.writeFile(path.join(installed, "index.d.ts"), "export type FsSafeErrorCode = string;\n");
  const inspected = inspectPublicApi({ packageName: "@openclaw/fs-safe", packageSubpaths: ["."], workdir: consumer });
  expect(inspected.packageSubpaths["."].types).toContain("FsSafeErrorCode");
  expect(inspected.packageSubpaths["."].errorCodes).toEqual({});
  const actual = structuredClone(manifest);
  actual.packageSubpaths["."].errorCodes = inspected.packageSubpaths["."].errorCodes;
  expect(() => assertPublicApi(actual)).toThrow("error-code type vanished from .: FsSafeErrorCode");
}, 15_000);

it("rejects function type-query exports introduced by a type-only star", async () => {
  const consumer = await tempRoot("fs-safe-api-surface-");
  const installed = path.join(consumer, "node_modules", "@openclaw", "fs-safe");
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}');
  await fs.writeFile(path.join(installed, "package.json"), JSON.stringify({
    name: "@openclaw/fs-safe", type: "module",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
  }));
  await fs.writeFile(path.join(installed, "index.js"), "export {};\n");
  await fs.writeFile(path.join(installed, "index.d.ts"), 'export type * from "./root.js";\n');
  await fs.writeFile(path.join(installed, "root.d.ts"), "export declare function rootOnly(): void;\n");
  expect(() => inspectPublicApi({
    packageName: "@openclaw/fs-safe", packageSubpaths: ["."], workdir: consumer,
  })).toThrow("unrecorded type-query export at .: rootOnly");
}, 15_000);
