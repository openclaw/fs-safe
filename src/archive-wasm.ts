import { readFileSync } from "node:fs";

// Node exposes WebAssembly without DOM globals; keep private ABI types local.
const wasm = (globalThis as unknown as { WebAssembly: {
  Module: { new(bytes: Uint8Array): object; imports(module: object): unknown[] };
  Instance: new(module: object) => { exports: object };
} }).WebAssembly;
let compiled: object | undefined;

export function createArchiveWasmInstance(): object {
  // src tests and dist consumers resolve the same generated package artifact.
  compiled ??= new wasm.Module(readFileSync(new URL("../dist/archive-parser.wasm", import.meta.url)));
  if (wasm.Module.imports(compiled).length) throw new Error("archive WASM unexpectedly requires host imports");
  return new wasm.Instance(compiled).exports;
}
