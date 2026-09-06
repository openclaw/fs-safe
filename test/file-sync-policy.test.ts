import { expect, it } from "vitest";
import { syncFileBestEffort, syncFileBestEffortSync } from "../src/file-sync.js";

it.each(["EPERM", "EIO"])("preserves sync receivers and the %s policy", async (code) => {
  const failure = Object.assign(new Error("sync failed"), { code });
  const handle = { async sync() { expect(this).toBe(handle); throw failure; } };
  const io = { fsyncSync(fd: number) { expect(this).toBe(io); expect(fd).toBe(42); throw failure; } };
  if (code === "EPERM") {
    await expect(syncFileBestEffort(handle)).resolves.toBeUndefined();
    expect(() => syncFileBestEffortSync(42, io)).not.toThrow();
  } else {
    await expect(syncFileBestEffort(handle)).rejects.toBe(failure);
    expect(() => syncFileBestEffortSync(42, io)).toThrow(failure);
  }
});

it.each([null, undefined])("preserves nullish sync failures (%s)", async (failure) => {
  const handle = { async sync() { throw failure; } };
  await expect(syncFileBestEffort(handle)).rejects.toBe(failure);
  let threw = false;
  try {
    syncFileBestEffortSync(42, { fsyncSync() { throw failure; } });
  } catch (error) {
    threw = true;
    expect(error).toBe(failure);
  }
  expect(threw).toBe(true);
});
