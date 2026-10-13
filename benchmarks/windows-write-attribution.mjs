// Temporary campaign diagnostic; measurements are separate from uninstrumented timing.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2] ?? "require";
const directory = path.resolve(process.argv[3] ?? "dist");
const output = process.argv[4];
const api = await import(pathToFileURL(path.join(directory, "index.js")));
api.configureFsSafeNative({ mode });
const binding = (await import(pathToFileURL(path.join(directory, "native.js")))).getNativeBinding();
assert(mode !== "require" || binding);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "write-attribution-"));
const root = await api.root(workspace);
const target = path.join(workspace, "output");
fs.writeFileSync(target, "seed");
const initial = await fsp.open(target, "r");
const prototype = Object.getPrototypeOf(initial);
await initial.close();
let active = false;
let epoch = 0n;
let events = [];
const undo = [];
const installed = [];
function wrap(object, names, prefix, callback = false) {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor?.writable || typeof descriptor.value !== "function") continue;
    const original = descriptor.value;
    const label = `${prefix}.${name}`;
    const wrapped = function (...args) {
      const event = active ? { call: label, startUs: Number(process.hrtime.bigint() - epoch) / 1000 } : undefined;
      if (event) events.push(event);
      const start = event ? process.hrtime.bigint() : 0n;
      const finish = () => { if (event) event.us = Number(process.hrtime.bigint() - start) / 1000; };
      if (callback && typeof args.at(-1) === "function") {
        const cb = args.at(-1);
        args[args.length - 1] = function (...result) { finish(); return Reflect.apply(cb, this, result); };
      }
      try {
        const result = Reflect.apply(original, this, args);
        if (result?.then) return result.then(value => {
          finish();
          if (prefix === "promises" && name === "open" && active) wrap(value, ["close"], "handle");
          return value;
        }, error => { finish(); throw error; });
        if (!callback || typeof args.at(-1) !== "function") finish();
        return result;
      } catch (error) { finish(); throw error; }
    };
    Object.assign(wrapped, original);
    Object.defineProperty(object, name, { ...descriptor, value: wrapped });
    installed.push(label);
    undo.push(() => Object.defineProperty(object, name, descriptor));
  }
}

wrap(fsp, Object.keys(fsp), "promises");
wrap(fs.realpathSync, ["native"], "fs.realpathSync");
wrap(fs, Object.keys(fs).filter(key => key.endsWith("Sync")), "fs");
wrap(fs, ["write"], "fs", true);
wrap(prototype, Object.getOwnPropertyNames(prototype).filter(key => !["constructor", "fd"].includes(key)), "handle");
wrap(cp, ["spawnSync", "execFileSync"], "child");
wrap(cp, ["exec", "execFile"], "child", true);
if (binding) wrap(binding, Object.keys(binding), "native");
syncBuiltinESMExports();
try {
  for (let i = 0; i < 30; i++) await root.write("output", "{\"value\":\"benchmark\"}\n", { durable: false });
  const samples = [];
  for (let i = 0; i < 101; i++) {
    events = [];
    epoch = process.hrtime.bigint();
    active = true;
    await root.write("output", "{\"value\":\"benchmark\"}\n", { durable: false });
    active = false;
    samples.push({ totalUs: Number(process.hrtime.bigint() - epoch) / 1000, events });
  }
  assert.equal(fs.readFileSync(target, "utf8"), "{\"value\":\"benchmark\"}\n");
  const result = { mode, node: process.version, platform: process.platform, cpus: os.cpus().length, load: os.loadavg(), installed, samples };
  if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result));
} finally {
  active = false;
  for (const restore of undo.reverse()) restore();
  syncBuiltinESMExports();
  fs.rmSync(workspace, { recursive: true });
}
