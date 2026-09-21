import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import type { NativeArchivePlanEntry } from "../src/native-binding.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const fields = ["index", "path", "kind", "size", "mode"] as const;

describe.skipIf(!paxNative)("native archive entry contract", () => {
  it.each(fields)("retains the plan type in malformed %s diagnostics", field => {
    const entry: Record<string, unknown> = { index: 0, path: "value", kind: "file", size: 0, mode: 0o600 };
    entry[field] = typeof entry[field] === "string" ? 1 : "1";
    expect(() => paxNative!.extractArchiveNative("unused", "invalid-format", -1,
      [entry as unknown as NativeArchivePlanEntry], resolveTarMeterLimits(), new AbortController().signal))
      .toThrow(new RegExp(` on NativeArchivePlanEntry\\.${field}$`));
  });

  it("preserves ordered plan reads and the exact getter failure", () => {
    const observed: string[] = [];
    const failure = new Error("plan getter failed");
    const entry = {
      get index() { observed.push("index"); return 0; },
      get path() { observed.push("path"); throw failure; },
      get kind() { observed.push("kind"); return "file" as const; },
      size: 0, mode: 0o600,
    };
    let caught: unknown;
    try {
      paxNative!.extractArchiveNative("unused", "invalid-format", -1,
        [entry], resolveTarMeterLimits(), new AbortController().signal);
    } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(observed).toEqual(["index", "path"]);
  });

  it.each(["tar", "gzip", "zip"] as const)("keeps %s manifest snapshots independent from retained reads", async format => {
    const payload = Buffer.from("retained archive bytes");
    let bytes = tarFixture([{ path: "é.txt", body: payload, mode: 0o640 }]);
    if (format === "gzip") bytes = gzipSync(bytes);
    if (format === "zip") {
      const zip = new JSZip();
      zip.file("é.txt", payload, { unixPermissions: 0o100640 });
      bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
    }
    const input = Buffer.allocUnsafeSlow(bytes.length);
    bytes.copy(input);
    const dir = await tempRoot("fs-safe-native-entry-");
    const archivePath = path.join(dir, "input");
    await fs.writeFile(archivePath, bytes);
    const kind = format === "zip" ? "zip" : "tar";
    const limits = resolveTarMeterLimits();
    const manifest = await paxNative!.inspectArchiveNative(archivePath, kind, limits, new AbortController().signal);
    const reader = kind === "zip"
      ? await paxNative!.openZipBufferNative(input, limits)
      : await paxNative!.openTarBufferNative(input, kind, limits);
    const snapshot = reader.entries;
    expect(snapshot).toEqual(manifest);
    expect(Object.getPrototypeOf(snapshot[0]!)).toBe(Object.prototype);
    expect(Object.keys(snapshot[0]!)).toEqual(fields);
    for (const field of fields) {
      expect(Object.getOwnPropertyDescriptor(snapshot[0]!, field))
        .toMatchObject({ writable: true, enumerable: true, configurable: true });
    }
    Object.assign(snapshot[0]!, { index: 999, path: "changed", kind: "directory", size: -1, mode: 0 });
    expect(reader.entries).toEqual(manifest);
    expect(await reader.readEntry(0, payload.length)).toEqual(payload);
  });
});
