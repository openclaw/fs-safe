import { expect, it } from "vitest";
import { median, parseSyscalls, renderNodeBaseline } from "../benchmarks/node-baseline-report.mjs";

it("retains the middle pair for even sample counts", () => {
  expect(median([100, 2, 8, 4])).toBe(6);
  expect(median([9, 1, 2])).toBe(2);
});

it("excludes setup, markers, event descriptors and cleanup from syscall counts", () => {
  const counts = parseSyscalls([
    '11 openat(AT_FDCWD, "fixture", O_CREAT) = 3',
    '11 write(2, "TRACE_START read raw\\n", 21) = 21',
    '12 openat(AT_FDCWD, "input", O_RDONLY) = 3',
    '12 read(3</input>, "hi", 2) = 2',
    '12 write(4<pipe:[12]>, "x", 1) = 1',
    '12 read(5<anon_inode:[eventfd]>, "x", 1) = 1',
    '11 write(2, "TRACE_END read raw\\n", 19) = 19',
    '12 close(3</input>) = 0',
  ].join("\n"));
  expect(counts).toEqual({ "read/raw": { openat: 1, read: 1 } });
  expect(() => parseSyscalls('11 write(2, "TRACE_START read raw\\n", 21) = 21')).toThrow(/Unclosed/);
  expect(() => parseSyscalls('11 write(2, "TRACE_END read raw\\n", 19) = 19')).toThrow(/Mismatched/);
});

it("keeps each mode's raw baseline and A/A separate in Markdown", () => {
  const report = (mode: string, rawNs: number) => ({ metadata: { mode, samples: 7 }, results: [{
    operation: "read", rawNs, safeNs: rawNs * 2, ratio: 2, aa: { ratio: 1 }, caveat: "Trusted paths only.",
  }] });
  const markdown = renderNodeBaseline([report("off", 100), report("require", 200)]);
  expect(markdown).toMatch(/\| read \| 100 \| 200 \| 2.00× \| 1.00× \| 200 \| 400 \| 2.00× \| 1.00× \|/);
  expect(markdown).toContain("NOT security-equivalent");
  expect(markdown).toContain("Trusted paths only");
});

it("accepts the built-in A/A control name in syscall windows", () => {
  expect(parseSyscalls([
    '11 write(2, "TRACE_START A/A-read raw\\n", 25) = 25',
    '12 read(3</input>, "hi", 2) = 2',
    '11 write(2, "TRACE_END A/A-read raw\\n", 23) = 23',
  ].join("\n"))).toEqual({ "A/A-read/raw": { read: 1 } });
});
