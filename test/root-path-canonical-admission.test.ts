import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pathPolicy from "../src/path.js";
import { realpathSync } from "../src/realpath.js";
import { rawPathRelativeToCanonicalRoot } from "../src/root-path-existing.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("canonical root-prefix pathname admission", () => {
  it.each(["non-directory", "lookup-error"] as const)(
    "rejects canonical aliases before a %s stat or containment check can mask them",
    (statResult) => {
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
      const root = path.resolve("canonical-admission-fixture");
      const candidate = path.join(root, "link", "child");
      const order: string[] = [];
      const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
        order.push("lstat");
        return { isSymbolicLink: () => true, isDirectory: () => false } as fs.Stats;
      });
      const canonicalize = vi.spyOn(realpathSync, "native").mockImplementation(() => {
        order.push("realpath");
        return `${root}:alias`;
      });
      const stat = vi.spyOn(fs, "statSync").mockImplementation(() => {
        order.push("stat");
        if (statResult === "lookup-error") throw new Error("unadmitted path inspected");
        return { isDirectory: () => false } as fs.Stats;
      });
      const containment = vi.spyOn(pathPolicy, "isPathInside").mockImplementation(() => {
        throw new Error("unadmitted path compared");
      });

      expect(() => rawPathRelativeToCanonicalRoot(candidate, root)).toThrow(
        expect.objectContaining({
          code: "invalid-path",
          details: { reason: "windows-path-alias" },
        }),
      );
      expect(order).toEqual(["lstat", "realpath"]);
      expect(lstat).toHaveBeenCalledTimes(1);
      expect(canonicalize).toHaveBeenCalledTimes(1);
      expect(stat).not.toHaveBeenCalled();
      expect(containment).not.toHaveBeenCalled();
    },
  );
});
