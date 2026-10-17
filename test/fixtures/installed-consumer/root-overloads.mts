import { root, type Root } from "@openclaw/fs-safe";
import { root as subpathRoot, type Root as SubpathRoot } from "@openclaw/fs-safe/root";
import type { DirEntry } from "@openclaw/fs-safe/types";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type RootExports = Expect<Equal<Root, SubpathRoot>>;
type RootFactoryExports = Expect<Equal<typeof root, typeof subpathRoot>>;
type State = { count: number };

export function overloads(scoped: Root, stream: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  const names = scoped.list(".");
  const explicitNames = scoped.list(".", { withFileTypes: false });
  const entries = scoped.list(".", { withFileTypes: true });
  const json = scoped.readJson<State>("state.json");
  const unknownJson = scoped.readJson("state.json");
  type Names = Expect<Equal<typeof names, Promise<string[]>>>;
  type ExplicitNames = Expect<Equal<typeof explicitNames, Promise<string[]>>>;
  type Entries = Expect<Equal<typeof entries, Promise<DirEntry[]>>>;
  type Json = Expect<Equal<typeof json, Promise<State>>>;
  type UnknownJson = Expect<Equal<typeof unknownJson, Promise<unknown>>>;
  scoped.create("buffered", "value", { atomic: true, encoding: "utf8" });
  scoped.create("streamed", stream, { maxBytes: 4096, signal, durable: "file" });
  // @ts-expect-error encoding belongs to buffered input
  scoped.create("streamed", stream, { encoding: "utf8" });
  // @ts-expect-error stream publication does not expose buffered atomic mode
  scoped.create("streamed", stream, { atomic: true });
  // @ts-expect-error create never overwrites an existing entry
  scoped.create("buffered", "value", { overwrite: true });
  // @ts-expect-error open returns a handle; it is not a bounded read
  scoped.open("file", { maxBytes: 4096 });
  // @ts-expect-error unspecified JSON data remains unknown
  const assumed: Promise<State> = unknownJson;
}
