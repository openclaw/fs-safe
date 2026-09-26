import { watch, type WatchOptions, type WatchSubscription } from "@openclaw/fs-safe/watch";
import type { Root } from "@openclaw/fs-safe/root";
export function observe(root: Root, options: WatchOptions): WatchSubscription {
  return watch(root, options);
}
