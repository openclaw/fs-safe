import { describe, expect, it } from "vitest";
import * as durability from "../src/durability.js";

describe("durability exports", () => {
  it("exposes the public directory durability surface", () => {
    expect(Object.keys(durability).toSorted()).toEqual([
      "ensureDurableDirectory",
      "pinDirectory",
      "syncDirectory",
      "syncDirectoryBestEffort",
      "syncDirectoryBestEffortSync",
      "syncDirectorySync",
    ]);
  });
});
