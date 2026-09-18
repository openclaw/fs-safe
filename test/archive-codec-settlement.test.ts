import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { createPortableTarDecoder } from "../src/archive-codec-wasm.js";

// Complete compressed members decoding to "left". The input deliberately
// stays open after this member, so error teardown must wake a pending read.
const members = {
  "tar-bzip2": "QlpoOTFBWSZTWboZAWMAAAEBgAMEBAAgACGaaDNNMLxdyRThQkLoZAWM",
  "tar-zstd": "KLUv/SQEIQAAbGVmdMib5kg=",
} as const;

describe.each(["tar-bzip2", "tar-zstd"] as const)("portable %s stream ownership", kind => {
  it.each(["downstream", "upstream", "abort", "destroy"] as const)(
    "joins both sides after %s failure without reading further input", async failure => {
      const primary = new Error("controlled stream failure");
      const controller = new AbortController();
      let reads = 0, readsAtFailure = -1, inputCleanup = false, triggered = false;
      const input = new Readable({
        highWaterMark: 65536,
        read() {
          reads++;
          if (reads === 1) this.push(Buffer.from(members[kind], "base64"));
        },
        destroy(error, done) {
          setImmediate(() => { inputCleanup = true; done(error); });
        },
      });
      const decoder = createPortableTarDecoder(kind, 1024, controller.signal);
      const sink = new Writable({
        write(chunk, _encoding, done) {
          expect(chunk.toString()).toBe("left");
          if (!triggered) {
            triggered = true;
            readsAtFailure = reads;
            if (failure === "downstream") { done(primary); return; }
            if (failure === "upstream") input.destroy(primary);
            if (failure === "abort") controller.abort(primary);
            if (failure === "destroy") decoder.destroy(primary);
          }
          done();
        },
      });
      expect(decoder.readableObjectMode).toBe(false);
      expect(decoder.writableObjectMode).toBe(false);
      expect(decoder.readableHighWaterMark).toBeLessThanOrEqual(65536);
      expect(decoder.writableHighWaterMark).toBeLessThanOrEqual(65536);
      try {
        const operation = pipeline(input, decoder, sink, { signal: controller.signal });
        if (failure === "abort") await expect(operation).rejects.toMatchObject({ name: "AbortError" });
        else await expect(operation).rejects.toBe(primary);
        expect(triggered).toBe(true);
        expect(inputCleanup).toBe(true);
        expect(input.closed).toBe(true);
        expect(decoder.closed).toBe(true);
        expect(sink.closed).toBe(true);
        expect(reads).toBe(readsAtFailure);
      } finally { input.destroy(); decoder.destroy(); sink.destroy(); }
    },
  );
});
