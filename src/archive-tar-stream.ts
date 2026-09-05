import fs from "node:fs";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { GzipInput, validateGzipContainerTail } from "./archive-gzip-tail.js";
import { ArchiveFormatError } from "./archive-errors.js";
import type { TarMeterLimits } from "./archive-limits.js";
import { TarParserStream, type AdmittedTarMember } from "./archive-tar-wasm.js";

async function gzipFile(filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const magic = Buffer.alloc(2);
    const { bytesRead } = await handle.read(magic, 0, 2, 0);
    return bytesRead === 2 && magic[0] === 31 && magic[1] === 139;
  } finally { await handle.close(); }
}

async function withTarStream<T>(params: {
  archivePath: string; limits: TarMeterLimits; signal?: AbortSignal;
  onMember?: (entry: AdmittedTarMember) => void;
}, consume: (parser: TarParserStream) => Promise<T>): Promise<T> {
  const gzip = await gzipFile(params.archivePath);
  const parser = new TarParserStream(params.limits, params.onMember);
  const input = fs.createReadStream(params.archivePath, { highWaterMark: 65536 });
  const decoder = gzip ? createGunzip() : undefined;
  const gzipInput = decoder ? new GzipInput(decoder) : undefined;
  const destroy = (error?: Error) => {
    input.destroy(error); gzipInput?.destroy(error); decoder?.destroy(error); parser.destroy(error);
  };
  const pumps = decoder && gzipInput
    ? [pipeline(decoder, parser, { signal: params.signal }), pipeline(input, gzipInput, { signal: params.signal })]
    : [pipeline(input, parser, { signal: params.signal })];
  // Either pump tears down both routes; join every pump even after the first failure.
  const settled = Promise.all(pumps.map((pump) => pump.then(() => undefined, (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    destroy(error);
    return error;
  }))).then((errors) => errors.find((error) => error !== undefined));
  try {
    const result = await consume(parser);
    const error = await settled;
    if (error) throw error;
    if (gzipInput) await validateGzipContainerTail(params.archivePath, gzipInput.tailOffset, params.signal);
    return result;
  } finally {
    destroy();
    await settled;
  }
}

export async function inspectTar(params: {
  archivePath: string; limits: TarMeterLimits; signal?: AbortSignal;
  onMember?: (entry: AdmittedTarMember) => void;
}): Promise<void> {
  await withTarStream(params, async (parser) => {
    await pipeline(parser, new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
  });
}

/** Replay in physical order, retaining at most one decoded chunk. Every range
 * comes from complete admission of the immutable staged input. */
export async function replayTar<T extends AdmittedTarMember>(params: {
  archivePath: string; limits: TarMeterLimits; signal?: AbortSignal;
  members: readonly T[];
  consume(member: T, payload: AsyncIterable<Buffer>): Promise<void>;
}): Promise<void> {
  await withTarStream(params, async (parser) => {
    const iterator = parser[Symbol.asyncIterator]();
    let chunk: Buffer = Buffer.alloc(0);
    let position = 0;
    async function* take(length: number): AsyncGenerator<Buffer> {
      while (length > 0) {
        if (!chunk.length) {
          const next = await iterator.next();
          if (next.done) throw new ArchiveFormatError("truncated admitted TAR range");
          chunk = next.value as Buffer;
        }
        const count = Math.min(length, chunk.length);
        const bytes = chunk.subarray(0, count);
        chunk = chunk.subarray(count);
        position += count; length -= count;
        yield bytes;
      }
    }
    for (const member of params.members) {
      if (member.offset < position) throw new ArchiveFormatError("invalid admitted TAR range order");
      for await (const _ of take(member.offset - position)) { /* Skip admitted gaps. */ }
      const payload = take(member.size);
      await params.consume(member, payload);
      for await (const _ of payload) { /* Directories may carry ignored dump data. */ }
      if (position !== member.offset + member.size) throw new ArchiveFormatError("incomplete TAR range consumption");
    }
    // Includes unrequested/skipped members, trailer checks, and physical EOF.
    while (!(await iterator.next()).done) { /* Drain the bounded parser stream. */ }
  });
}
