import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { registerPrivateLockedJson } from "../benchmarks/private-locked-json.mjs";
import { fileStore } from "../src/file-store.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

type Row = {
  name: string;
  run(): Promise<unknown>;
  after(result: unknown): void;
  workloadDetails: { depth: number; relativePath: string; private: boolean; lock: boolean; durable: boolean };
};
const { tempRoot } = useRealTempDirs();
afterEach(() => __resetFsSafeNativeConfigForTest());

async function fixture() {
  configureFsSafeNative({ mode: "off" });
  const workspace = await tempRoot("fs-safe-locked-json-benchmark-");
  const rows: Row[] = [];
  registerPrivateLockedJson({ api: { fileStore }, workspace, register(name: string, run: Row["run"], options: Omit<Row, "name" | "run">) {
    rows.push({ name, run, ...options });
  } });
  return { workspace, rows };
}

it("qualifies both locked private update rows through consecutive untimed public calls", async () => {
  const { rows } = await fixture();
  expect(rows.map(row => row.name)).toEqual([
    "JsonStore.update/private=true/lock=true/flat/durable=false",
    "JsonStore.update/private=true/lock=true/depth=8/durable=false",
  ]);
  for (const row of rows) {
    expect(row.workloadDetails).toMatchObject({ private: true, lock: true, durable: false });
    for (const count of [1, 2]) {
      const result = await row.run();
      row.after(result);
      expect(result).toEqual({ count, payload: "private locked JSON admission" });
    }
  }
});

it.each(["returned value", "disk JSON", "sidecar", "ancestor debris"])("rejects incorrect %s after an untimed update", async fault => {
  const { workspace, rows } = await fixture();
  const row = rows[1]!;
  const result = await row.run();
  const rootDir = path.join(workspace, "private-locked-json-8");
  const filePath = path.join(rootDir, row.workloadDetails.relativePath);
  if (fault === "disk JSON") fs.writeFileSync(filePath, "{}\n");
  if (fault === "sidecar") fs.writeFileSync(`${filePath}.lock`, "not released");
  if (fault === "ancestor debris") fs.writeFileSync(path.join(rootDir, "unexpected"), "debris");
  expect(() => row.after(fault === "returned value" ? { count: 0 } : result)).toThrow();
});

it.skipIf(process.platform === "win32").each(["file", "directory"])("rejects a changed private %s mode outside the timer", async target => {
  const { workspace, rows } = await fixture();
  const row = rows[0]!;
  const result = await row.run();
  const rootDir = path.join(workspace, "private-locked-json-0");
  fs.chmodSync(target === "file" ? path.join(rootDir, "state.json") : rootDir, target === "file" ? 0o644 : 0o755);
  expect(() => row.after(result)).toThrow(/mode changed/);
});
