import { checkedWatchStat, checkWatchRoot, type WatchStatRequest } from "./watch-io.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { configureFsSafeNative } from "./native-config.js";
import { resolvePathInRoot, type RootContext } from "./root-context.js";
import { assertRootDirectoryObservationGuard, createRootDirectoryObservationGuard, openRootDirectoryListing } from "./root-directory-list.js";
import { lookupRootDirectoryEntry } from "./root-directory-entry.js";
import type { RootDirectoryListing } from "./root-directory-list-types.js";
import { encodeWatchError as errorWire } from "./watch-io-error.js";

// This worker owns only filesystem observations. Callbacks and transport policy
// remain with the subscription; no worker observation grants read authority.
const counts: Record<string, number> = {};
if (workerData.diagnostics) for (const [target, methods, prefix] of [
  [fs, ["lstatSync", "statSync", "realpathSync", "openSync", "closeSync", "fstatSync", "readlinkSync"], "sync."],
  [fsp, ["lstat", "stat", "realpath", "opendir", "readdir", "open"], "async."],
  [fs.Dir.prototype, ["readSync", "read", "closeSync", "close"], "dir."],
] as const) for (const method of methods) {
  const object = target as unknown as Record<string, any>;
  const original = object[method];
  object[method] = function (this: unknown, ...args: unknown[]) {
    counts[prefix + method] = (counts[prefix + method] ?? 0) + 1;
    return Reflect.apply(original, this, args);
  };
  Object.assign(object[method], original);
}
configureFsSafeNative(workerData.native);
const listings = new Map<number, RootDirectoryListing>();
let nextListing = 0;
let allowance = 0, consumed = 0;
let cleanupErrors: unknown[] = [];

async function run(method: string, args: any[], root: RootContext): Promise<unknown> {
  switch (method) {
    case "metrics": return counts;
    case "root": return checkWatchRoot(root);
    case "resolve": return resolvePathInRoot(root, args[0], args[1]);
    case "guard": return createRootDirectoryObservationGuard(root, args[0]);
    case "assert": return assertRootDirectoryObservationGuard(root, args[0]);
    case "lookup": return lookupRootDirectoryEntry(root, args[0], args[1], args[2]);
    case "stat": return args[0].map((request: WatchStatRequest) => {
      const { dev, ino, mode, nlink, size, mtimeNs, ctimeNs } = checkedWatchStat(request);
      return { dev, ino, mode, nlink, size, mtimeNs, ctimeNs };
    });
    case "open": {
      const listing = await openRootDirectoryListing(root, args[0], {
        ...args[1], onCleanupFailure: (error: unknown) => cleanupErrors.push(error),
        admitEntry: () => { if (consumed >= allowance) return false; consumed++; return true; },
      });
      const id = ++nextListing;
      listings.set(id, listing);
      return { id, paths: listing.paths };
    }
    case "next": {
      allowance = args[1]; consumed = 0;
      try { return { entry: await listings.get(args[0])!.next(), consumed }; }
      catch (error) { return { entryError: errorWire(error), failed: true, consumed }; }
    }
    case "current": return listings.get(args[0])!.assertCurrent();
    case "close": {
      const listing = listings.get(args[0]);
      listings.delete(args[0]);
      return listing?.[Symbol.asyncDispose]();
    }
    default: throw new Error("unknown watch observation request");
  }
}

// Serial execution also bounds in-flight handles and metadata batches.
let pending = Promise.resolve();
parentPort!.on("message", ({ id, method, args, root }) => {
  pending = pending.then(async () => {
    cleanupErrors = [];
    try { parentPort!.postMessage({ id, value: await run(method, args, root), cleanupErrors: cleanupErrors.map(errorWire) }); }
    catch (error) {
      const wire = errorWire(error);
      parentPort!.postMessage({ id, error: wire, failed: true, cleanupErrors: cleanupErrors.map(item => item === error ? wire : errorWire(item)) });
    }
  });
});
