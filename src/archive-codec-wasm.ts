import { Duplex, PassThrough, Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { ArchiveFormatError } from "./archive-errors.js";
import { classifyArchiveParserError } from "./archive-parser-errors.js";
import { createArchiveWasmInstance } from "./archive-wasm.js";

export type PortableTarCodec = "tar-bzip2" | "tar-zstd";
type NodeStreamPair = { writable: PassThrough; readable: Readable };
type Abi = {
  memory: { buffer: ArrayBuffer };
  codec_init(kind: number, limit: number): number;
  codec_input_ptr(): number;
  codec_output_ptr(): number;
  codec_step(offset: number, length: number, eof: number): number;
  codec_used(): number;
  codec_written(): number;
  codec_error_ptr(): number;
  codec_error_len(): number;
  codec_dispose(): void;
};
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function view(abi: Abi, pointer: number, length: number): Uint8Array {
  const memory = abi.memory.buffer;
  if (!Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 || length < 0 ||
      pointer > memory.byteLength || length > memory.byteLength - pointer) {
    throw new ArchiveFormatError("invalid archive codec WASM memory range");
  }
  return new Uint8Array(memory, pointer, length);
}

export function createPortableTarDecoder(kind: PortableTarCodec, maxDecodedBytes: number, signal?: AbortSignal): Duplex {
  const input = new PassThrough({ highWaterMark: 65536 });
  const decode = async function* (source: AsyncIterable<Buffer>) {
    const abi = createArchiveWasmInstance() as Abi;
    let failed = false;
    try {
      if (abi.codec_init(kind === "tar-bzip2" ? 1 : 2, maxDecodedBytes) !== 0) {
        throw new RangeError("invalid archive codec limits");
      }
      async function* step(length: number, eof: boolean): AsyncGenerator<Buffer> {
        let offset = 0;
        while (true) {
          signal?.throwIfAborted();
          const code = abi.codec_step(offset, length - offset, Number(eof));
          if (code < 0) {
            const message = textDecoder.decode(view(abi, abi.codec_error_ptr(), abi.codec_error_len()));
            throw classifyArchiveParserError(message) ?? new ArchiveFormatError(message || `invalid ${kind} archive`);
          }
          const used = abi.codec_used();
          const written = abi.codec_written();
          if (code > 2 || used > length - offset || written > 65536 ||
              !Number.isInteger(used) || used < 0 || !Number.isInteger(written) || written < 0) {
            throw new ArchiveFormatError("invalid archive codec WASM progress");
          }
          offset += used;
          // Never let a downstream consumer retain a view into the reusable inbox.
          if (written) yield Buffer.from(view(abi, abi.codec_output_ptr(), written));
          // Even highly compressible or skippable input must yield to cancellation.
          await setImmediate(undefined, { signal });
          if (code === 1 || code === 2) {
            if (offset !== length || (code === 2) !== eof) {
              throw new ArchiveFormatError("incomplete archive codec input");
            }
            return;
          }
        }
      }
      for await (const chunk of source) {
        try {
          for (let offset = 0; offset < chunk.length; offset += 65536) {
            const length = Math.min(65536, chunk.length - offset);
            view(abi, abi.codec_input_ptr(), length).set(chunk.subarray(offset, offset + length));
            yield* step(length, false);
          }
        } catch (error) {
          // Iterator return otherwise replaces the decoder error with AbortError.
          input.destroy(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }
      yield* step(0, true);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try { abi.codec_dispose(); }
      // A WASM trap can leave Rust's borrow guard set. Keep the original fault.
      catch (error) { if (!failed) throw error; }
    }
  };
  // Separate owners wake pending input reads before joining the generator.
  // Node 22's Duplex.from(generator) can strand them on downstream errors.
  const output = Readable.from(decode(input), { objectMode: false, highWaterMark: 65536 });
  // @types/node omits the documented Node-stream pair overload.
  return (Duplex.from as typeof Duplex.from & ((pair: NodeStreamPair) => Duplex))({ writable: input, readable: output });
}
