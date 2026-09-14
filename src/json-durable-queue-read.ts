import fs, { type BigIntStats } from "node:fs";
import { normalizeMaxBytes } from "./byte-budget.js";
import { readBoundedAsync } from "./bounded-read.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { inspectFileIdentity } from "./strict-file-identity.js";

export const DEFAULT_JSON_DURABLE_QUEUE_ENTRY_MAX_BYTES = 16 * 1024 * 1024;

async function inspectQueueEntry(
  inspect: () => BigIntStats,
  maxBytes: number,
  expected?: BigIntStats,
): Promise<BigIntStats> {
  let inspectionFailed = false;
  try {
    return await inspectFileIdentity(async () => {
      try {
        const stat = inspect();
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error("queue entry is not a regular file");
        }
        if (stat.nlink > 1n) throw new Error("queue entry hardlinks are not allowed");
        if (stat.size > maxBytes) throw new Error(`queue entry exceeds ${maxBytes} bytes`);
        return stat;
      } catch (error) {
        inspectionFailed = true;
        throw error;
      }
    }, expected);
  } catch (error) {
    // Translate only the identity helper's rejection, never inspection errors.
    if (inspectionFailed) throw error;
    throw new Error("queue entry changed during read", { cause: error });
  }
}

export async function withJsonDurableQueueEntry<T, R>(
  filePath: string,
  options: { maxBytes?: number },
  run: (entry: T, identity: BigIntStats, releaseReadPin: () => Promise<void>) => Promise<R>,
): Promise<R> {
  const maxBytes = normalizeMaxBytes(options.maxBytes, {
    defaultValue: DEFAULT_JSON_DURABLE_QUEUE_ENTRY_MAX_BYTES,
  })!;
  const inspectPath = () => fs.lstatSync(filePath, { bigint: true });
  const initialStat = await inspectQueueEntry(inspectPath, maxBytes);
  const handle = await fs.promises.open(filePath, resolveReadOpenFlags());
  let closePromise: Promise<void> | undefined;
  const releaseReadPin = (): Promise<void> =>
    closePromise ??= (async () => { await handle.close(); })();
  try {
    const openedStat = await inspectQueueEntry(
      () => fs.fstatSync(handle.fd, { bigint: true }), maxBytes, initialStat,
    );
    await inspectQueueEntry(inspectPath, maxBytes, openedStat);
    const bytes = await readBoundedAsync(
      maxBytes,
      async (buffer, length) => (await handle.read(buffer, 0, length, null)).bytesRead,
      {
        initialSize: openedStat.size >= 0n && Number.isSafeInteger(Number(openedStat.size))
          ? Number(openedStat.size) : undefined,
        createLimitError: () => new Error(`queue entry exceeds ${maxBytes} bytes`),
      },
    );
    // The migration owner may release this pin only at the verified publication
    // boundary; until then an unlinked inode cannot be recycled into a new claim.
    return await run(JSON.parse(bytes.toString("utf8")) as T, openedStat, releaseReadPin);
  } finally {
    await releaseReadPin();
  }
}
