import { expect } from "vitest";

export type CodecAbi = {
  memory: WebAssembly.Memory;
  codec_init(kind: number): number;
  codec_input_ptr(): number;
  codec_output_ptr(): number;
  codec_push(length: number): number;
  codec_finish(): number;
  codec_dispose(): void;
  codec_consumed(): number;
  codec_produced(): number;
  codec_error_ptr(): number;
  codec_error_len(): number;
  input_ptr(): number;
  init(entries: number, metadata: number, decoded: number, manifest: number, windows: number): number;
  push(offset: number, length: number): number;
  finish(): number;
  dispose(): void;
  text_ptr(): number;
  text_len(): number;
  member_type(): number;
};

export function codecAbi(module: WebAssembly.Module): CodecAbi {
  return new WebAssembly.Instance(module).exports as unknown as CodecAbi;
}

export function codecError(abi: CodecAbi): string {
  return new TextDecoder().decode(new Uint8Array(abi.memory.buffer, abi.codec_error_ptr(), abi.codec_error_len()));
}

export function codecDecode(abi: CodecAbi, bytes: Buffer, chunkSize = 65536, onChunk?: (chunk: Buffer) => void) {
  const chunks: Buffer[] = [];
  let offset = 0;
  let end = 0;
  let draining = false;
  let emptyInputOutputCalls = 0;
  let zeroBoundaryTransitions = 0;
  for (let calls = 0; calls < 10000000; calls++) {
    if (!draining && offset === end) end = Math.min(bytes.length, offset + chunkSize);
    const length = draining ? 0 : end - offset;
    new Uint8Array(abi.memory.buffer, abi.codec_input_ptr(), length).set(bytes.subarray(offset, offset + length));
    const result = abi.codec_push(length);
    if (result < 0) throw new Error(codecError(abi));
    const consumed = abi.codec_consumed();
    const produced = abi.codec_produced();
    if (consumed < 0 || consumed > length || produced < 0 || produced > 65536) throw new Error("invalid codec progress");
    offset += consumed;
    if (produced) {
      const chunk = Buffer.from(new Uint8Array(abi.memory.buffer, abi.codec_output_ptr(), produced));
      chunks.push(chunk);
      onChunk?.(chunk);
      if (!length) emptyInputOutputCalls++;
      draining = true;
    } else if (!length) {
      draining = false;
      if (offset < bytes.length) continue;
      if (abi.codec_finish() < 0) throw new Error(codecError(abi));
      return { bytes: Buffer.concat(chunks), emptyInputOutputCalls, zeroBoundaryTransitions };
    } else if (!consumed) {
      if (result !== 1 || ++zeroBoundaryTransitions > 100) throw new Error("codec stalled");
    }
  }
  throw new Error("codec exceeded call ceiling");
}

export function parserPush(abi: CodecAbi, bytes: Buffer): string[] {
  const names: string[] = [];
  for (let base = 0; base < bytes.length; base += 65536) {
    const chunk = bytes.subarray(base, base + 65536);
    new Uint8Array(abi.memory.buffer, abi.input_ptr(), chunk.length).set(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const used = abi.push(offset, chunk.length - offset);
      if (used <= 0) throw new Error(new TextDecoder().decode(new Uint8Array(abi.memory.buffer, abi.text_ptr(), abi.text_len())));
      offset += used;
      if (abi.member_type() >= 0) names.push(new TextDecoder().decode(new Uint8Array(abi.memory.buffer, abi.text_ptr(), abi.text_len())));
    }
  }
  return names;
}

export function lowMemoryIntact(abi: CodecAbi): void {
  expect(Buffer.from(abi.memory.buffer, 0, 64).equals(Buffer.alloc(64))).toBe(true);
}

export function skippableFrame(bytes: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50);
  header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
