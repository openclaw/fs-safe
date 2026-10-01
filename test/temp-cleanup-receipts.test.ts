import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { __cleanupRegisteredTempPathForTest, registerTempPathForExit } from "../src/temp-cleanup.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

it.each([false, true])("does not adopt a preexisting entry without a receipt (directory=%s)", async directory => {
  const root = await tempRoot("fs-safe-temp-cleanup-no-receipt-");
  const entry = path.join(root, "entry");
  if (directory) await fs.mkdir(entry);
  const payload = directory ? path.join(entry, "payload") : entry;
  await fs.writeFile(payload, "unrelated");
  const unregister = registerTempPathForExit(entry, { recursive: directory, singleLinkFile: !directory });
  try {
    __cleanupRegisteredTempPathForTest(entry);
    expect(await fs.readFile(payload, "utf8")).toBe("unrelated");
    expect(await fs.readdir(root)).toEqual(["entry"]);
  } finally {
    unregister();
  }
});

it("cleans a pending registration after receiving its admitted descriptor receipt", async () => {
  const root = await tempRoot("fs-safe-temp-cleanup-later-receipt-");
  const entry = path.join(root, "entry");
  const unregister = registerTempPathForExit(entry, { singleLinkFile: true });
  try {
    const handle = await fs.open(entry, "wx", 0o600);
    try {
      unregister.setIdentity(await handle.stat({ bigint: true }));
      await handle.writeFile("owned");
    } finally {
      await handle.close();
    }
    __cleanupRegisteredTempPathForTest(entry);
    await expect(fs.lstat(entry)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
  } finally {
    unregister();
  }
});

it("does not revive an unregistered entry when a later receipt arrives", async () => {
  const root = await tempRoot("fs-safe-temp-cleanup-terminal-receipt-");
  const entry = path.join(root, "entry");
  await fs.writeFile(entry, "successor");
  const unregister = registerTempPathForExit(entry);
  unregister();
  unregister.setIdentity(await fs.lstat(entry, { bigint: true }));
  __cleanupRegisteredTempPathForTest(entry);
  expect(await fs.readFile(entry, "utf8")).toBe("successor");
});
