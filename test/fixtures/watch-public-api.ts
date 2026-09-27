import { watch, type WatchOptions, type WatchSubscription } from "@openclaw/fs-safe/watch";
import type { Root } from "@openclaw/fs-safe/root";
export function observe(root: Root, options: WatchOptions): WatchSubscription {
  return watch(root, { ...options, persistent: false });
}
const defaultOptions: WatchOptions = { mode: "poll", scopes: [], onInvalidate() {} };
const persistentOptions: WatchOptions = { ...defaultOptions, persistent: true };
const pollingOptions: WatchOptions = { ...defaultOptions, mode: "auto", pollIntervalMs: 25 };
// @ts-expect-error pollIntervalMs accepts only a number.
const invalidPollingOptions: WatchOptions = { ...defaultOptions, pollIntervalMs: "25" };
// @ts-expect-error persistent accepts only a boolean.
const invalidOptions: WatchOptions = { ...defaultOptions, persistent: "false" };
void [persistentOptions, pollingOptions, invalidPollingOptions, invalidOptions];
