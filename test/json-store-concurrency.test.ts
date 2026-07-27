import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJsonStore,
  type JsonStore,
  type JsonStoreAdapter,
} from "../src/json-document-store.js";
import { jsonStore } from "../src/json-store.js";

type State = { count: number };
type Mutation = "update" | "updateOr" | "write";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function runMutation(
  store: JsonStore<State>,
  mutation: Mutation,
  count: number,
  onUpdate?: () => Promise<void>,
): Promise<void> {
  if (mutation === "write") {
    await store.write({ count });
    return;
  }
  const update = async (current: State | undefined): Promise<State> => {
    expect(current?.count ?? 0).toBe(count - 1);
    await onUpdate?.();
    return { count };
  };
  if (mutation === "update") {
    await store.update(update);
  } else {
    await store.updateOr({ count: 0 }, update);
  }
}

describe("jsonStore mutation serialization", () => {
  it("preserves every overlapping update from the issue reproduction", async () => {
    const root = await tempRoot("fs-safe-json-store-concurrent-");
    const filePath = path.join(root, "state.json");
    await jsonStore<State>({ filePath, lock: true }).write({ count: 0 });

    await Promise.all(
      [0, 1, 2].map(async (index) => {
        await delay(index * 5);
        await jsonStore<State>({ filePath, lock: true }).updateOr(
          { count: 0 },
          async (current) => {
            await delay(20);
            return { count: current.count + 1 };
          },
        );
      }),
    );

    await expect(jsonStore<State>({ filePath }).readRequired()).resolves.toEqual({ count: 3 });
  });

  it.each<readonly [Mutation, Mutation]>(
    (["update", "updateOr", "write"] as const).flatMap((first) =>
      (["update", "updateOr", "write"] as const).map((second) => [first, second] as const),
    ),
  )("serializes overlapping %s then %s calls", async (firstMutation, secondMutation) => {
    const root = await tempRoot("fs-safe-json-store-pairs-");
    const filePath = path.join(root, "state.json");
    let stored: State | undefined = { count: 0 };
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;

    const adapter = (
      onRead: () => Promise<void>,
      onWrite: () => Promise<void>,
    ): JsonStoreAdapter<State> => ({
      filePath,
      readIfExists: async () => {
        await onRead();
        return stored && { ...stored };
      },
      readRequired: async () => {
        await onRead();
        if (!stored) throw new Error("missing test state");
        return { ...stored };
      },
      write: async (value) => {
        await onWrite();
        stored = { ...value };
      },
    });

    const firstStore = createJsonStore(
      adapter(
        async () => undefined,
        async () => {
          if (firstMutation === "write") {
            firstEntered.resolve();
            await releaseFirst.promise;
          }
        },
      ),
      { lock: true },
    );
    const secondStore = createJsonStore(
      adapter(
        async () => {
          secondEntered = true;
        },
        async () => {
          secondEntered = true;
        },
      ),
      { lock: true },
    );

    const first = runMutation(firstStore, firstMutation, 1, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = runMutation(secondStore, secondMutation, 2);
    try {
      await delay(10);
      expect(secondEntered).toBe(false);
    } finally {
      releaseFirst.resolve();
    }
    await Promise.all([first, second]);
    expect(stored).toEqual({ count: 2 });
  });

  it.runIf(process.platform !== "win32")(
    "shares one queue across canonical parent aliases",
    async () => {
      const root = await tempRoot("fs-safe-json-store-alias-");
      const realDir = path.join(root, "real");
      const aliasDir = path.join(root, "alias");
      await fsp.mkdir(realDir);
      await fsp.symlink(realDir, aliasDir, "dir");
      let stored: State | undefined = { count: 0 };
      let aliasRead = false;
      const firstEntered = deferred();
      const releaseFirst = deferred();
      const adapter = (filePath: string, onRead: () => void): JsonStoreAdapter<State> => ({
        filePath,
        readIfExists: async () => {
          onRead();
          return stored && { ...stored };
        },
        readRequired: async () => {
          onRead();
          if (!stored) throw new Error("missing test state");
          return { ...stored };
        },
        write: async (value) => {
          stored = { ...value };
        },
      });
      const realStore = createJsonStore(adapter(path.join(realDir, "state.json"), () => undefined));
      const aliasStore = createJsonStore(
        adapter(path.join(aliasDir, "state.json"), () => {
          aliasRead = true;
        }),
      );

      const first = realStore.update(async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return { count: 1 };
      });
      await firstEntered.promise;
      const second = aliasStore.update((current) => ({ count: (current?.count ?? 0) + 1 }));
      try {
        await delay(10);
        expect(aliasRead).toBe(false);
      } finally {
        releaseFirst.resolve();
      }
      await Promise.all([first, second]);
      expect(stored).toEqual({ count: 2 });
    },
  );

  it("rejects nested updates with a typed error across a queueMicrotask boundary", async () => {
    const root = await tempRoot("fs-safe-json-store-reentrant-");
    const filePath = path.join(root, "state.json");
    const store = jsonStore<State>({ filePath, lock: true });
    await store.write({ count: 0 });

    const nested = store.update(async () =>
      await new Promise<State>((resolve, reject) => {
        queueMicrotask(() => {
          void store.update((current) => ({ count: (current?.count ?? 0) + 1 })).then(resolve, reject);
        });
      }),
    );

    await expect(nested).rejects.toMatchObject({
      name: "FsSafeError",
      code: "store-reentrant-update",
      message: expect.stringContaining("return the complete next value from the outer update"),
    });
    await expect(store.readRequired()).resolves.toEqual({ count: 0 });
  });
});
