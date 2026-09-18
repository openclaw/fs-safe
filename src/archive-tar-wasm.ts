import { classifyArchiveParserError } from "./archive-parser-errors.js";
import { readFileSync } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { ArchiveFormatError } from "./archive-errors.js";
import type { TarMeterLimits } from "./archive-limits.js";
import type { TarEntryInfo } from "./archive-tar.js";

export type AdmittedTarMember = TarEntryInfo & { offset: number };
type Abi = {
  memory: { buffer: ArrayBuffer };
  input_ptr(): number;
  init(entries: number, metadata: number, decoded: number, manifest: number, windows: number): number;
  push(offset: number, length: number): number;
  finish(): number;
  dispose(): void;
  text_ptr(): number;
  text_len(): number;
  member_type(): number;
  member_size(): number;
  member_offset(): number;
  member_mode(): number;
  codec_init(kind: number): number;
  codec_input_ptr(): number;
  codec_output_ptr(): number;
  codec_push(length: number): number;
  codec_consumed(): number;
  codec_produced(): number;
  codec_finish(): number;
  codec_error_ptr(): number;
  codec_error_len(): number;
  codec_dispose(): void;
};
// Node exposes WebAssembly without DOM globals; keep the private ABI types local.
const wasm = (globalThis as unknown as { WebAssembly: {
  Module: { new(bytes: Uint8Array): object; imports(module: object): unknown[] };
  Instance: new(module: object) => { exports: object };
} }).WebAssembly;
let compiled: object | undefined;
function instance(): Abi {
  // src tests and dist consumers resolve the same generated package artifact.
  compiled ??= new wasm.Module(readFileSync(new URL("../dist/archive-parser.wasm", import.meta.url)));
  if (wasm.Module.imports(compiled).length) throw new Error("TAR WASM unexpectedly requires host imports");
  return new wasm.Instance(compiled).exports as unknown as Abi;
}
const types = new Map([
  [0, "File"], [48, "File"], [49, "Link"], [50, "SymbolicLink"],
  [51, "CharacterDevice"], [52, "BlockDevice"], [53, "Directory"],
  [54, "FIFO"], [55, "ContiguousFile"], [68, "GNUDumpDir"],
]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parserError(message: string): Error {
  const mapped = classifyArchiveParserError(message);
  if (mapped) return mapped;
  return new ArchiveFormatError(message.replace(/^archive-header-invalid:/, "invalid TAR header:"));
}

/** One bounded memory domain owns both admission and decompression. Its owner
 * must join the decoder and parser before disposing this shared instance. */
export class TarWasmSession {
  private abi: Abi | undefined;
  constructor(limits: TarMeterLimits) {
    this.abi = instance();
    if (this.abi.init(limits.maxEntries, limits.maxMetaEntryBytes, limits.maxDecodedBytes, limits.maxManifestBytes, Number(process.platform === "win32")) !== 0) {
      this.dispose();
      throw new RangeError("invalid TAR parser limits");
    }
  }
  private bytes(pointer: number, length: number): Uint8Array {
    const memory = this.abi!.memory.buffer;
    if (!Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 || length < 0 ||
        pointer > memory.byteLength || length > memory.byteLength - pointer) {
      throw new ArchiveFormatError("invalid TAR WASM memory range");
    }
    return new Uint8Array(memory, pointer, length);
  }
  private text(): string {
    const abi = this.abi!;
    return utf8Decoder.decode(this.bytes(abi.text_ptr(), abi.text_len()));
  }
  parse(chunk: Buffer, onMember?: (entry: AdmittedTarMember) => void): void {
    const abi = this.abi!;
    for (let offset = 0; offset < chunk.length; offset += 65536) {
      const length = Math.min(65536, chunk.length - offset);
      this.bytes(abi.input_ptr(), length).set(chunk.subarray(offset, offset + length));
      // A member event can stop before the end of this already-copied inbox.
      for (let consumed = 0; consumed < length;) {
        const used = abi.push(consumed, length - consumed);
        if (used < 0) throw parserError(this.text());
        if (used === 0 || used > length - consumed) throw new ArchiveFormatError("TAR WASM made no progress");
        consumed += used;
        const type = abi.member_type();
        if (type >= 0) onMember?.({
          path: this.text(), type: types.get(type) ?? "Unsupported", size: abi.member_size(),
          mode: abi.member_mode(), offset: abi.member_offset(),
        });
      }
    }
  }
  finish(): void {
    if (this.abi!.finish() !== 0) throw parserError(this.text());
  }
  private codecError(): Error {
    const abi = this.abi!;
    return new ArchiveFormatError(utf8Decoder.decode(this.bytes(abi.codec_error_ptr(), abi.codec_error_len())));
  }
  async *decode(source: AsyncIterable<Buffer>, kind: "tar-zstd" | "tar-bzip2", signal?: AbortSignal): AsyncGenerator<Buffer> {
    const abi = this.abi!;
    signal?.throwIfAborted();
    if (abi.codec_init(kind === "tar-bzip2" ? 1 : 2) !== 0) throw this.codecError();
    let work = 0;
    let calls = 0;
    let unconsumedBoundary = false;
    const step = (input: Buffer): { output?: Buffer; consumed: number } => {
      signal?.throwIfAborted();
      this.bytes(abi.codec_input_ptr(), input.length).set(input);
      const result = abi.codec_push(input.length);
      if (result < 0) throw this.codecError();
      const consumed = abi.codec_consumed(), produced = abi.codec_produced();
      if (!Number.isInteger(consumed) || consumed < 0 || consumed > input.length ||
          !Number.isInteger(produced) || produced < 0 || produced > 65536 ||
          (result !== 0 && result !== 1) ||
          (input.length > 0 && consumed === 0 && produced === 0 && (result !== 1 || unconsumedBoundary))) {
        throw new ArchiveFormatError("compressed TAR WASM made no progress");
      }
      if (input.length > 0) unconsumedBoundary = consumed === 0 && produced === 0;
      work += consumed + produced;
      calls++;
      // The parser can grow this same memory, and the next codec call reuses it.
      return { consumed, output: produced ? Buffer.from(this.bytes(abi.codec_output_ptr(), produced)) : undefined };
    };
    const empty = Buffer.alloc(0);
    // Yield even for output-free skippable frames and arbitrarily small members.
    const yieldIfNeeded = async () => {
      if (work >= 256 * 1024 || calls >= 32) {
        work = 0; calls = 0;
        await setImmediate(undefined, { signal });
      }
      signal?.throwIfAborted();
    };
    for await (const chunk of source) {
      for (let offset = 0; offset < chunk.length;) {
        const { consumed, output } = step(chunk.subarray(offset, offset + 65536));
        offset += consumed;
        if (output) yield output;
        await yieldIfNeeded();
        // A full output window can leave more decoded bytes with no new input.
        if (output) {
          for (;;) {
            const drained = step(empty);
            if (drained.output) yield drained.output;
            await yieldIfNeeded();
            if (!drained.output) break;
          }
        }
      }
    }
    // Physical EOF, rather than a selected range or TAR EOF, ends the decoder.
    for (;;) {
      const drained = step(empty);
      if (drained.output) yield drained.output;
      await yieldIfNeeded();
      if (!drained.output) break;
    }
    if (abi.codec_finish() !== 0) throw this.codecError();
  }
  dispose(): void {
    const abi = this.abi;
    this.abi = undefined;
    if (abi) {
      try { abi.codec_dispose(); }
      finally { abi.dispose(); }
    }
  }
}

/** Backpressure-aware transport only; all TAR semantics live in the Rust core. */
export class TarParserStream extends Transform {
  private readonly session: TarWasmSession;
  private readonly ownsSession: boolean;
  constructor(limits: TarMeterLimits, private readonly onMember?: (entry: AdmittedTarMember) => void, session?: TarWasmSession) {
    super();
    this.session = session ?? new TarWasmSession(limits);
    this.ownsSession = session === undefined;
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try { this.session.parse(chunk, this.onMember); callback(null, chunk); }
    catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
  }
  override _flush(callback: TransformCallback): void {
    try { this.session.finish(); callback(); }
    catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
  }
  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    try { if (this.ownsSession) this.session.dispose(); }
    catch (cause) { error ??= cause instanceof Error ? cause : new Error(String(cause)); }
    callback(error);
  }
}
