import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { expect, it, vi } from "vitest";
import { createPortableTarDecoder } from "../src/archive-codec-wasm.js";
import * as wasm from "../src/archive-wasm.js";

it("preserves a decoder trap when disposal also encounters poisoned state", async () => {
  const primary = new Error("decoder allocation trapped");
  const dispose = vi.fn(() => { throw new Error("borrow guard already held"); });
  const instance = vi.spyOn(wasm, "createArchiveWasmInstance").mockReturnValue({
    memory: { buffer: new ArrayBuffer(65536) }, codec_init: () => 0, codec_input_ptr: () => 0,
    codec_step: () => { throw primary; }, codec_dispose: dispose,
  });
  try {
    await expect(pipeline(Readable.from([Buffer.from("input")]), createPortableTarDecoder("tar-zstd", 100),
      new Writable({ write(_chunk, _encoding, done) { done(); } }))).rejects.toBe(primary);
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally { instance.mockRestore(); }
});
