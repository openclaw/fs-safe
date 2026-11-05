import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openPublicationPin } from "../src/publication-pin.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());
it.runIf(process.platform === "linux" || process.platform === "darwin").each(["wx", "wx+"])(
  "pins the unlinked allocation after closing a %s writer", async access => {
    const name = path.join(await tempRoot("publication-pin-"), "file");
    const writer = fs.openSync(name, access, 0o600);
    let pin: number | undefined;
    let closed = false;
    try {
      const identity = fs.fstatSync(writer, { bigint: true });
      pin = openPublicationPin(writer);
      fs.unlinkSync(name);
      fs.closeSync(writer);
      closed = true;
      fs.writeFileSync(name, "replacement");
      expect(fs.fstatSync(pin, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino, nlink: 0n });
      expect(fs.lstatSync(name, { bigint: true }).ino).not.toBe(identity.ino);
    } finally {
      if (!closed) fs.closeSync(writer);
      if (pin !== undefined) fs.closeSync(pin);
    }
  },
);

it("refuses a non-procfs namespace before releasing the writer", async () => {
  const name = path.join(await tempRoot("publication-pin-proc-"), "file");
  const writer = fs.openSync(name, "wx", 0o600);
  try {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue({ type: 0n } as fs.BigIntStatsFs);
    expect(() => openPublicationPin(writer)).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
    expect(fs.fstatSync(writer).isFile()).toBe(true);
  } finally { fs.closeSync(writer); }
});

it("fails closed when the platform cannot retain a descriptor alias", async () => {
  const name = path.join(await tempRoot("publication-pin-unsupported-"), "file");
  const writer = fs.openSync(name, "wx", 0o600);
  try {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(() => openPublicationPin(writer)).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
    expect(fs.fstatSync(writer).isFile()).toBe(true);
  } finally { fs.closeSync(writer); }
});
