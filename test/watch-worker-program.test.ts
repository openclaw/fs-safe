import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { nativeRecursiveWatchPlatform, nodeWatchProgram } from "../src/watch-worker.js";
import type { NodeWatchHint } from "../src/watch-node.js";

// Execute the exact fixed worker program with only its two imported transports
// substituted. This is parser/protocol proof, not a simulated OS qualification.
async function worker(platform: string, maxPendingPaths = 2) {
  const commands = new EventEmitter();
  const messages: Array<{ type: string; hints?: NodeWatchHint[]; overflow?: boolean }> = [];
  const registrations: Array<{ target: string; recursive: boolean; emit(event: string, name: string | null): void }> = [];
  let closed = 0;
  const parentPort = Object.assign(commands, {
    postMessage(message: typeof messages[number]) { messages.push(structuredClone(message)); },
    close() {},
  });
  const workerData = { platform, recursiveRoot: nativeRecursiveWatchPlatform(platform), maxPendingPaths };
  const load = async (name: string) => {
    if (name === "node:worker_threads") return { parentPort, workerData };
    if (name !== "node:fs") throw new Error("unexpected worker dependency");
    return { watch(target: string, options: { recursive: boolean }, emit: (event: string, name: string | null) => void) {
      registrations.push({ target, recursive: options.recursive, emit });
      return Object.assign(new EventEmitter(), { close() { closed++; } });
    } };
  };
  expect(nodeWatchProgram.match(/await import[(]/g)).toHaveLength(2);
  await new Function("load", "return " + nodeWatchProgram.replaceAll("await import(", "await load(").trim())(load);
  commands.emit("message", { type: "add", path: "authority", relative: "", id: 1 });
  return { commands, messages, registrations, closeCount: () => closed,
    dirty(name: string | null) { registrations[0]!.emit("change", name); },
    latest: () => messages.filter(message => message.type === "dirty").at(-1),
  };
}

it("selects only native directory-recursive platforms, never Linux per-file recursion", async () => {
  for (const platform of ["darwin", "win32", "linux", "freebsd"]) {
    const w = await worker(platform);
    expect(w.registrations).toHaveLength(1);
    expect(w.registrations[0]).toMatchObject({ target: "authority", recursive: platform === "darwin" || platform === "win32" });
    w.commands.emit("message", { type: "close" });
    expect(w.closeCount()).toBe(1);
  }
});

describe.each(["darwin", "win32"])("worker %s raw names", platform => {
  it("splits deep paths using platform semantics without case or Unicode folding", async () => {
    const w = await worker(platform);
    w.dirty("Tree/é/FILE.md");
    expect(w.latest()?.hints).toEqual([{ directory: platform === "win32" ? "Tree\\é" : "Tree/é", name: "FILE.md", event: "change" }]);
    w.commands.emit("message", { type: "close" });
  });
  it("keeps malformed and unknown names detail-free", async () => {
    for (const name of [null, "", ".", "..", "/absolute", "a//b", "a/../b", "a/./b", "a/\0b", ...(platform === "win32" ? ["C:/absolute", "a/stream:data"] : [])]) {
      const w = await worker(platform);
      w.dirty(name);
      expect(w.latest()?.hints).toEqual([{ directory: "", name: null, event: "change" }]);
      w.commands.emit("message", { type: "close" });
    }
  });
  it("bounds queued raw paths and retires without later hints", async () => {
    const w = await worker(platform, 2);
    w.dirty("first");
    w.dirty("a/b"); w.dirty("c/d"); w.dirty("e/f");
    expect(w.messages.filter(message => message.type === "dirty")).toHaveLength(1);
    w.commands.emit("message", { type: "ack" });
    expect(w.latest()).toMatchObject({ overflow: true, hints: [] });
    w.commands.emit("message", { type: "close" });
    const count = w.messages.length;
    w.dirty("late"); w.commands.emit("message", { type: "ack" });
    expect(w.messages).toHaveLength(count);
    expect(w.closeCount()).toBe(1);
  });
});

it("preserves Darwin backslash and colon as literal data, not Windows separators", async () => {
  const w = await worker("darwin");
  w.dirty("a\\b:dir/name\\with:colon");
  expect(w.latest()?.hints).toEqual([{ directory: "a\\b:dir", name: "name\\with:colon", event: "change" }]);
  w.commands.emit("message", { type: "close" });
});
it("splits Windows backslash paths into native directory keys", async () => {
  const w = await worker("win32");
  w.dirty("a\\b\\file");
  expect(w.latest()?.hints).toEqual([{ directory: "a\\b", name: "file", event: "change" }]);
  w.commands.emit("message", { type: "close" });
});
