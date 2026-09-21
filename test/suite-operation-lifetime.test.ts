import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";

type Hook = () => unknown;
type TestCallback = (...args: unknown[]) => unknown;
type SuiteCase = {
  label: string;
  suite: string;
  test: string;
  load: () => Promise<unknown>;
  skip: boolean;
  setup: Hook[];
  afterEach: Hook[];
  afterAll: Hook[];
  callback?: Hook;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const cases: SuiteCase[] = [
  {
    label: "root copy",
    suite: "Root publication modes with native off",
    test: "copyIn honors $modeSource mode $octal (replacement: $replacement)",
    load: () => import("./root-write-mode.test.js"),
    skip: process.platform === "win32",
  },
  {
    label: "ZIP aliases",
    suite: "ZIP kind contract (off)",
    test: "preserves internal separator/dot aliases and matching terminal markers",
    load: () => import("./archive-zip-kind.test.js"),
    skip: false,
  },
].map(entry => ({ ...entry, setup: [], afterEach: [], afterAll: [] }));

let collecting = cases[0]!;
const register = (name: string, fn: TestCallback, args: unknown[] = []) => {
  if (name === collecting.test && !collecting.callback) collecting.callback = () => fn(...args);
};
const ignore = () => {};
const collectTest = Object.assign(register, {
  each: (rows: unknown[]) => (name: string, fn: TestCallback) => {
    for (const row of rows) register(name, fn, Array.isArray(row) ? row : [row]);
  },
  skipIf: (skip: boolean) => skip ? ignore : register,
  runIf: (enabled: boolean) => enabled ? register : ignore,
});
const collectSuite = (name: string, fn: Hook) => {
  if (name === collecting.suite) fn();
};
const runHooks = async (hooks: Hook[]) => {
  for (const hook of hooks) await hook();
};

vi.doMock("vitest", () => ({
  expect,
  vi,
  it: collectTest,
  describe: Object.assign(collectSuite, {
    skipIf: (skip: boolean) => skip ? ignore : collectSuite,
  }),
  beforeAll: (hook: Hook) => { collecting.setup.push(hook); },
  afterEach: (hook: Hook) => { collecting.afterEach.unshift(hook); },
  afterAll: (hook: Hook) => { collecting.afterAll.unshift(hook); },
}));
try {
  for (const selected of cases) {
    if (selected.skip) continue;
    collecting = selected;
    await selected.load();
    if (!selected.callback) throw new Error(`Missing existing ${selected.label} callback`);
  }
} finally { vi.doUnmock("vitest"); }
const nativeConfig = await import("../src/native-config.js");

for (const selected of cases) {
  it.skipIf(selected.skip)(`${selected.label} retains its fixture and backend until interrupted work settles`, async () => {
    const { setup, afterEach, afterAll, callback } = selected;

    const entered = deferred<string>();
    const release = deferred<void>();
    const directories: string[] = [];
    const mkdtemp = fs.mkdtemp.bind(fs);
    const readdir = fs.readdir.bind(fs);
    let running = false;
    let held = false;
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
      const directory = await mkdtemp(...args);
      directories.push(String(directory));
      return directory;
    });
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const entries = await readdir(...args);
      if (running && !held) {
        held = true;
        entered.resolve(String(args[0]));
        await release.promise;
      }
      return entries;
    });

    let operation: Promise<unknown> | undefined;
    let teardown: Promise<void> | undefined;
    let finishedEach = false;
    try {
      await runHooks(setup);
      running = true;
      operation = Promise.resolve().then(callback);
      const directory = await Promise.race([
        entered.promise,
        operation.then(() => { throw new Error("Callback completed before filesystem gate"); }),
      ]);
      // Vitest starts teardown when its deadline rejects, without joining the callback.
      finishedEach = true;
      await runHooks(afterEach);
      teardown = runHooks(afterAll);
      const mode = nativeConfig.getFsSafeNativeConfig().mode;
      const paths = await Promise.allSettled([fs.stat(directory), fs.stat(directories[0]!)]);
      expect({ mode, directoriesExist: paths.map(result => result.status === "fulfilled" && result.value.isDirectory()) })
        .toEqual({ mode: "off", directoriesExist: [true, true] });
    } finally {
      release.resolve();
      await Promise.allSettled([operation, teardown]);
      if (!finishedEach) await runHooks(afterEach);
      if (!teardown) await runHooks(afterAll);
      vi.restoreAllMocks();
    }
    await operation;
    await teardown;
    expect(directories.length).toBeGreaterThan(0);
    await expect(fs.stat(directories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
}
