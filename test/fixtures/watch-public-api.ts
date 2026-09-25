import type { WatchDirty } from "@openclaw/fs-safe/watch";

type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
export type WatchDirtyReasonContract = Assert<Equal<WatchDirty["reason"], "event" | "reconcile" | "overflow">>;
