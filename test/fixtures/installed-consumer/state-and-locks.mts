import { fileStore, jsonStore } from "@openclaw/fs-safe/store";
import { acquireFileLock, acquireFileLockSync, withFileLock, withFileLockSync } from "@openclaw/fs-safe/file-lock";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type State = { count: number };

export function storesAndLocks(rootDir: string, filePath: string) {
  const store = fileStore({ rootDir });
  const standalone = jsonStore<State>({ filePath });
  const document = store.json<State>("state.json");
  const optional = document.read();
  const nullable = store.readJsonIfExists<State>("state.json");
  const updated = standalone.update(current => ({ count: (current?.count ?? 0) + 1 }));
  const asyncUpdated = document.updateOr({ count: 0 }, async current => ({ count: current.count + 1 }));
  type Optional = Expect<Equal<typeof optional, Promise<State | undefined>>>;
  type Nullable = Expect<Equal<typeof nullable, Promise<State | null>>>;
  type Updated = Expect<Equal<typeof updated, Promise<State>>>;
  type AsyncUpdated = Expect<Equal<typeof asyncUpdated, Promise<State>>>;
  // @ts-expect-error store writes retain their generic state contract
  document.write({ count: "wrong" });
  // @ts-expect-error async updates also retain the state contract
  document.update(async () => ({ count: "wrong" }));
  // @ts-expect-error absence is not a required document
  const required: Promise<State> = optional;
  // @ts-expect-error file-store absence is null
  const alsoRequired: Promise<State> = nullable;

  acquireFileLock(filePath, { payload: async () => ({ owner: "consumer" }), shouldReclaim: async params => !params.heldByThisProcess });
  acquireFileLockSync(filePath, {
    payload: () => ({ owner: "consumer" }),
    shouldReclaim(params) {
      type Unheld = Expect<Equal<typeof params.heldByThisProcess, false>>;
      return !params.heldByThisProcess;
    },
  });
  const locked = withFileLock(filePath, { payload: () => ({}) }, async () => ({ count: 1 }));
  const lockedSync = withFileLockSync(filePath, { payload: () => ({}) }, () => ({ count: 1 }));
  type Locked = Expect<Equal<typeof locked, Promise<State>>>;
  type LockedSync = Expect<Equal<typeof lockedSync, State>>;
  // @ts-expect-error synchronous reclaim cannot wait for a Promise
  acquireFileLockSync(filePath, { payload: () => ({}), shouldReclaim: async () => true });
  // @ts-expect-error lock payloads are records
  acquireFileLock(filePath, { payload: () => 1 });
  // @ts-expect-error the async wrapper requires a Promise-returning callback
  withFileLock(filePath, { payload: () => ({}) }, () => 1);
}
