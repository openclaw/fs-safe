import { describe, expect, it } from "vitest";
import * as durability from "../src/durability.js";

describe("durability exports", () => {
  it("exposes the public directory durability surface", () => {
    expect(Object.keys(durability).toSorted()).toEqual([
      "ensureDurableDirectory",
      "isHardlinkFallbackError",
      "pinDirectory",
      "publishFileExclusive",
      "sha256File",
      "sha256FileSync",
      "syncDirectory",
      "syncDirectoryBestEffort",
      "syncDirectoryBestEffortSync",
      "syncDirectorySync",
    ]);
  });
});
