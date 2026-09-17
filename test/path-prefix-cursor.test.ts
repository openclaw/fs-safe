import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePathPrefixSync } from "../src/advanced.js";
import { observeArrayShifts } from "./helpers/observe-array-shifts.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const SHIFT_QUEUE_COMPONENT_LIMIT = 32;
const directoryLink = process.platform === "win32" ? "junction" : "dir";
const { tempRoot } = useRealTempDirs();

function rawComponentCount(absolutePath: string): number {
  const root = path.parse(absolutePath).root;
  return absolutePath.slice(root.length).split(path.sep).length;
}

function resolveWithMarkedShiftCounts(input: string, markerGroups: readonly (readonly string[])[]) {
  const observed = observeArrayShifts(markerGroups, () => resolvePathPrefixSync(input));
  if (!observed.ok) throw observed.error;
  return { result: observed.result, markedShifts: observed.markedShifts };
}

function populatedPathAtComponentCount(base: string, componentCount: number): string {
  const baseCount = rawComponentCount(base);
  expect(baseCount).toBeLessThan(componentCount);
  const suffix = Array.from(
    { length: componentCount - baseCount },
    (_, index) => `d${String(baseCount + index + 1).padStart(2, "0")}`,
  );
  const populated = path.join(base, ...suffix);
  fs.mkdirSync(populated, { recursive: true });
  expect(rawComponentCount(populated)).toBe(componentCount);
  return populated;
}

function sourceAtComponentCount(
  base: string,
  aliasName: string,
  missingName: string,
  componentCount: number,
): string {
  const ordinary = `${base}${path.sep}${aliasName}${path.sep}${missingName}`;
  const extra = componentCount - rawComponentCount(ordinary);
  expect(extra).toBeGreaterThanOrEqual(0);
  const input = `${base}${path.sep.repeat(extra + 1)}${aliasName}${path.sep}${missingName}`;
  expect(rawComponentCount(input)).toBe(componentCount);
  return input;
}

describe("resolvePathPrefixSync forced cursor mode", () => {
  it("preserves empty, dot, parent, and trailing missing suffix semantics", async () => {
    const directory = await tempRoot("fs-safe-prefix-forced-cursor-");
    const child = path.join(directory, "child-marker");
    fs.mkdirSync(child);
    const missing = "missing-marker";
    const cases = [
      {
        input: `${directory}${path.sep.repeat(40)}`,
        marker: path.basename(directory),
        existingPath: directory,
        unresolvedSegments: [],
      },
      {
        input: `${directory}${path.sep.repeat(40)}.`,
        marker: path.basename(directory),
        existingPath: directory,
        unresolvedSegments: [],
      },
      {
        input: `${child}${path.sep.repeat(40)}..`,
        marker: "child-marker",
        existingPath: directory,
        unresolvedSegments: [],
      },
      {
        input: `${directory}${path.sep.repeat(40)}${missing}${path.sep}${path.sep}.${path.sep}..${path.sep}`,
        marker: missing,
        existingPath: directory,
        unresolvedSegments: [missing, "", ".", "..", ""],
      },
    ];

    const shiftDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "shift");
    for (const testCase of cases) {
      expect(rawComponentCount(testCase.input)).toBeGreaterThan(SHIFT_QUEUE_COMPONENT_LIMIT);
      const { result, markedShifts } = resolveWithMarkedShiftCounts(
        testCase.input,
        [[testCase.marker]],
      );
      expect(markedShifts).toEqual([0]);
      expect(result).toEqual({
        absolutePath: testCase.input,
        existingPath: fs.realpathSync.native(testCase.existingPath),
        unresolvedSegments: testCase.unresolvedSegments,
      });
    }
    expect(Object.getOwnPropertyDescriptor(Array.prototype, "shift")).toEqual(shiftDescriptor);
  });

  it("rejects a non-directory followed only by trailing separators", async () => {
    const directory = await tempRoot("fs-safe-prefix-forced-notdir-");
    const file = path.join(directory, "file-marker");
    fs.writeFileSync(file, "kept");
    const input = `${file}${path.sep.repeat(40)}`;
    expect(rawComponentCount(input)).toBeGreaterThan(SHIFT_QUEUE_COMPONENT_LIMIT);
    const shiftDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "shift");
    const observed = observeArrayShifts([["file-marker"]], () => resolvePathPrefixSync(input));
    expect(observed.ok).toBe(false);
    if (observed.ok) throw new Error("non-directory traversal unexpectedly succeeded");
    expect(observed.error).toEqual(expect.objectContaining({ code: "ENOTDIR" }));
    expect(observed.markedShifts).toEqual([0]);
    expect(Object.getOwnPropertyDescriptor(Array.prototype, "shift")).toEqual(shiftDescriptor);
  });

  it.each([
    ["small", "small"],
    ["small", "large"],
    ["large", "small"],
    ["large", "large"],
  ] as const)(
    "preserves the %s-to-%s actual directory-link expansion transition",
    async (sourceClass, targetClass) => {
      const directory = await tempRoot(`fs-safe-prefix-${sourceClass}-${targetClass}-`);
      const smallTarget = path.join(directory, "small-target-marker");
      fs.mkdirSync(smallTarget);
      const largeTarget = populatedPathAtComponentCount(directory, SHIFT_QUEUE_COMPONENT_LIMIT);
      const target = targetClass === "small" ? smallTarget : largeTarget;
      const targetMarker = path.basename(target);
      const aliasName = `alias-${sourceClass}-${targetClass}`;
      const alias = path.join(directory, aliasName);
      fs.symlinkSync(target, alias, directoryLink);
      const missing = "missing-after-link";
      const input = sourceClass === "small"
        ? `${alias}${path.sep}${missing}`
        : sourceAtComponentCount(directory, aliasName, missing, SHIFT_QUEUE_COMPONENT_LIMIT + 1);
      expect(rawComponentCount(input) <= SHIFT_QUEUE_COMPONENT_LIMIT).toBe(sourceClass === "small");

      const { result, markedShifts } = resolveWithMarkedShiftCounts(input, [
        [aliasName, missing],
        [targetMarker, missing],
      ]);

      expect(markedShifts[0] === 0).toBe(sourceClass === "large");
      expect(markedShifts[1] === 0).toBe(targetClass === "large");
      expect(result).toEqual({
        absolutePath: input,
        existingPath: fs.realpathSync.native(target),
        unresolvedSegments: [missing],
      });
    },
  );
});
