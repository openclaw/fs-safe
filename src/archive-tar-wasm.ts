import { readFileSync } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";
import { ArchiveFormatError, ArchiveSecurityError, isArchiveTarPathErrorMessage } from "./archive-errors.js";
import { ARCHIVE_LIMIT_ERROR_CODE, ArchiveLimitError, type TarMeterLimits } from "./archive-limits.js";
import type { TarEntryInfo } from "./archive-tar.js";

export type AdmittedTarMember = TarEntryInfo & { offset: number };
type Abi = {
  memory: { buffer: ArrayBuffer };
  input_ptr(): number;
  init(entries: number, metadata: number, decoded: number, manifest: number, windows: number): number;
  push(length: number): number;
  finish(): number;
  dispose(): void;
  text_ptr(): number;
  text_len(): number;
  member_type(): number;
  member_size(): number;
  member_offset(): number;
  member_mode(): number;
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

function parserError(message: string): Error {
  if (isArchiveTarPathErrorMessage(message)) return new ArchiveSecurityError("entry-path", message);
  for (const code of Object.values(ARCHIVE_LIMIT_ERROR_CODE)) {
    if (message.includes(code)) return new ArchiveLimitError(code);
  }
  return new ArchiveFormatError(message.replace(/^archive-header-invalid:/, "invalid TAR header:"));
}

/** Backpressure-aware transport only; all TAR semantics live in the Rust core. */
export class TarParserStream extends Transform {
  private abi: Abi | undefined;
  constructor(limits: TarMeterLimits, private readonly onMember?: (entry: AdmittedTarMember) => void) {
    super();
    this.abi = instance();
    if (this.abi.init(limits.maxEntries, limits.maxMetaEntryBytes, limits.maxDecodedBytes, limits.maxManifestBytes, Number(process.platform === "win32")) !== 0) {
      this.abi.dispose();
      this.abi = undefined;
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
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.bytes(abi.text_ptr(), abi.text_len()));
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const abi = this.abi!;
      for (let offset = 0; offset < chunk.length;) {
        const length = Math.min(65536, chunk.length - offset);
        this.bytes(abi.input_ptr(), length).set(chunk.subarray(offset, offset + length));
        const used = abi.push(length);
        if (used < 0) throw parserError(this.text());
        if (used === 0 || used > length) throw new ArchiveFormatError("TAR WASM made no progress");
        offset += used;
        const type = abi.member_type();
        if (type >= 0) this.onMember?.({
          path: this.text(), type: types.get(type) ?? "Unsupported", size: abi.member_size(),
          mode: abi.member_mode(), offset: abi.member_offset(),
        });
      }
      callback(null, chunk);
    } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
  }
  override _flush(callback: TransformCallback): void {
    try {
      if (this.abi!.finish() !== 0) throw parserError(this.text());
      callback();
    } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
  }
  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    try { this.abi?.dispose(); }
    catch (cause) { error ??= cause instanceof Error ? cause : new Error(String(cause)); }
    finally { this.abi = undefined; }
    callback(error);
  }
}
