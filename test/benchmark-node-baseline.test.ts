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

it("labels candidate comparisons without calling the baseline raw Node", () => {
  const markdown = renderNodeBaseline([{
    metadata: { mode: "off", samples: 9, comparison: { baselineDistSha256: "fixture" } },
    results: [{ operation: "read", rawNs: 100, safeNs: 80, ratio: 0.8, aa: { ratio: 1 }, caveat: "Both arms retain admission." }],
  }]);
  expect(markdown).toContain("candidate/baseline");
  expect(markdown).toContain("Baseline off ns/op");
  expect(markdown).not.toContain("Raw Node");
});

it("keeps each comparison arm's setup, verification and cleanup with its implementation", async () => {
  const { compareNodeBaselineCases } = await import("../benchmarks/node-baseline-cases.mjs");
  const events: string[] = [];
  const make = (name: string) => ({
    operation: "read", sync: false,
    safe: (input: string) => `${name}:${input}`,
    before: (implementation: string) => { expect(implementation).toBe("safe"); events.push(`${name}:before`); return name; },
    verify: (output: string, implementation: string, input: string) => {
      expect(implementation).toBe("safe"); expect(output).toBe(`${name}:${input}`); events.push(`${name}:verify`);
    },
    after: (_output: string, implementation: string) => { expect(implementation).toBe("safe"); events.push(`${name}:after`); },
  });
  const [row] = compareNodeBaselineCases([make("candidate")], [make("baseline")]);
  for (const role of ["raw", "safe"] as const) {
    const input = row.before(role);
    const output = row[role](input);
    row.verify(output, role, input);
    row.after(output, role, input);
  }
  expect(events).toEqual(["baseline:before", "baseline:verify", "baseline:after", "candidate:before", "candidate:verify", "candidate:after"]);
  expect(() => compareNodeBaselineCases([make("candidate")], [])).toThrow();
});
