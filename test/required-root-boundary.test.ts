import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { requirePathInsideRoot } from "../src/root-boundary.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

it("returns the admitted pathname and relative path without inspecting an exact prefix", () => {
  const rootPath = path.resolve("required-root");
  const candidatePath = path.join(rootPath, "child", "value");
  const inspect = vi.spyOn(fs, "lstatSync");

  expect(requirePathInsideRoot(rootPath, candidatePath)).toEqual({
    path: candidatePath, relativePath: path.join("child", "value"), admission: "exact",
  });
  expect(inspect).not.toHaveBeenCalled();
});

it.each(["../outside", "../required-root-sibling/value"])(
  "reports the canonical public boundary error for %s",
  relativePath => {
    const rootPath = path.resolve("required-root");
    let error: unknown;
    try { requirePathInsideRoot(rootPath, path.resolve(rootPath, relativePath)); }
    catch (caught) { error = caught; }

    expect(error).toBeInstanceOf(FsSafeError);
    expect(error).toMatchObject({
      name: "FsSafeError", code: "outside-workspace", category: "policy",
      message: "file is outside workspace root", details: undefined,
    });
    expect(Object.hasOwn(error as object, "cause")).toBe(false);
  },
);

it.each(["C:\\Trusted\\Root\\child", "\\\\?\\C:\\Trusted\\Root\\child"])(
  "retains observation-free exact Windows admission for %s",
  candidatePath => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const inspect = vi.spyOn(fs, "lstatSync");
    expect(requirePathInsideRoot("C:\\Trusted\\Root", candidatePath, { dev: 11n, ino: 22n })).toEqual({
      path: "C:\\Trusted\\Root\\child", relativePath: "child", admission: "exact",
    });
    expect(inspect).not.toHaveBeenCalled();
  },
);

it.each(["same", "different", "transient-unknown", "persistent-unknown"] as const)(
  "retains strict Windows identity admission for a %s root",
  scenario => {
    Object.defineProperty(process, "platform", { value: "win32" });
    let observations = 0;
    const inspect = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      observations += 1;
      return {
        dev: scenario === "persistent-unknown" || (scenario === "transient-unknown" && observations === 1) ? 0n : 11n,
        ino: scenario === "different" ? 23n : 22n,
        isDirectory: () => true, isSymbolicLink: () => false,
      } as fs.BigIntStats;
    });
    const admission = () => requirePathInsideRoot(
      "C:\\Trusted\\Root", "c:\\trusted\\root\\Child", { dev: 11n, ino: 22n },
    );
    if (scenario === "same" || scenario === "transient-unknown") {
      expect(admission()).toEqual({
        path: "C:\\Trusted\\Root\\Child", relativePath: "Child", admission: "identity",
      });
    } else {
      expect(admission).toThrow(expect.objectContaining({ code: "outside-workspace", category: "policy" }));
    }
    expect(inspect).toHaveBeenCalledTimes(scenario.endsWith("unknown") ? 2 : 1);
    for (const [pathname, options] of inspect.mock.calls) {
      expect(pathname).toBe("c:\\trusted\\root");
      expect(options).toEqual({ bigint: true });
    }
  },
);
