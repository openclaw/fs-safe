import fs from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";

describe("temp directory fixture", () => {
  const { tempRoot } = useTempDirs();
  let createdDirectory = "";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await expect(fs.lstat(createdDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up after local mock restoration", async () => {
    createdDirectory = await tempRoot("fs-safe-temp-fixture-order-");
    const rm = vi.spyOn(fs, "rm").mockRejectedValue(new Error("mocked rm must be restored first"));

    expect(rm).not.toHaveBeenCalled();
  });
});
