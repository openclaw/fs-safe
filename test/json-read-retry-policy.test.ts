import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readJson, readJsonIfExists, tryReadJson } from "../src/json.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

const readers = [
  { name: "readJson", read: readJson, lenient: false },
  { name: "readJsonIfExists", read: readJsonIfExists, lenient: false },
  { name: "tryReadJson", read: tryReadJson, lenient: true },
];
const outcomes = [
  { label: "transient EPERM", code: "EPERM", failures: 2, attempts: 3, succeeds: true },
  { label: "persistent EPERM", code: "EPERM", failures: Infinity, attempts: 5, succeeds: false },
  { label: "persistent EIO", code: "EIO", failures: Infinity, attempts: 1, succeeds: false },
];

it.each(readers.flatMap(reader => outcomes.map(outcome => ({ ...reader, ...outcome }))))(
  "$name preserves its $label retry policy and byte-cap snapshot",
  async ({ read, lenient, code, failures, attempts, succeeds }) => {
    const directory = await tempRoot("fs-safe-json-retry-policy-");
    const filePath = path.join(directory, "state.json");
    const content = '{"ok":true}';
    await fs.writeFile(filePath, content);
    let capReads = 0;
    const options = {
      get maxBytes() {
        capReads += 1;
        return Buffer.byteLength(content);
      },
    };
    const failure = Object.assign(new Error("synthetic open failure"), { code });
    let opened = 0;
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === filePath) {
        opened += 1;
        // A pending read owns its admitted cap even if the caller changes options.
        Object.defineProperty(options, "maxBytes", { value: 0, configurable: true });
        if (opened <= failures) throw failure;
      }
      return await open(...args);
    });

    const pending = read(filePath, options);
    if (succeeds) await expect(pending).resolves.toEqual({ ok: true });
    else if (lenient) await expect(pending).resolves.toBeNull();
    else await expect(pending).rejects.toMatchObject({
      name: "JsonFileReadError", reason: "read", cause: failure,
    });
    expect(opened).toBe(attempts);
    expect(capReads).toBe(1);
    expect(await fs.readFile(filePath, "utf8")).toBe(content);
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
  },
);
