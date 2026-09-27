import fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";

export const below = (parent, child) => parent === child || !parent || child.startsWith(parent + path.sep);
export const scopeSets = [
  [{ path: "", kind: "tree", depth: 32 }],
  [{ path: "", kind: "tree", depth: 1 }],
  [{ path: "d0", kind: "tree", depth: 32 }],
  [{ path: "d1", kind: "entry" }, { path: "d2", kind: "tree", depth: 2 }],
  [{ path: "d0", kind: "tree", depth: 1 }, { path: path.join("d0", "nested"), kind: "tree", depth: 32 }],
  [{ path: "link", kind: "tree", depth: 32 }],
  [],
];
export const operation = fc.record({
  kind: fc.constantFrom("put", "removeFile", "removeDir", "renameFile", "renameDir", "replace", "block", "deep", "link", "burst", "scopes", "supersede", "reopen", "checkpoint"),
  slot: fc.integer({ min: 0, max: 3 }),
  target: fc.integer({ min: 0, max: 3 }),
  value: fc.integer({ min: 0, max: 1000 }),
});
export const sequences = (minLength, maxLength) => fc.array(operation, { minLength, maxLength, size: "+2" });

export function selectedDepth(scopes, name) {
  let result = -1;
  for (const scope of scopes) {
    if (!below(scope.path, name)) continue;
    const distance = name === scope.path ? 0 : (scope.path ? name.slice(scope.path.length + 1) : name).split(path.sep).length;
    const depth = scope.kind === "tree" ? scope.depth ?? 32 : 0;
    if (distance <= depth) result = Math.max(result, depth - distance);
  }
  return result;
}

// Mutations deliberately use raw fs as an external actor. All observation uses Root.
export function mutations(directory, outside, model) {
  let serial = 0;
  const full = name => path.join(directory, name);
  const forget = name => { for (const key of model.keys()) if (below(name, key)) model.delete(key); };
  async function remove(name) {
    if (!model.has(name)) return;
    await fs.rm(full(name), { recursive: true, force: true }); forget(name);
  }
  async function mkdir(name) {
    let current = "";
    for (const part of name.split(path.sep)) {
      current = path.join(current, part);
      if (model.has(current) && model.get(current) !== "directory") await remove(current);
      await fs.mkdir(full(current), { recursive: true });
      model.set(current, "directory");
    }
  }
  async function put(name, value) {
    await mkdir(path.dirname(name));
    const content = `payload-${value}-${++serial}`;
    await fs.writeFile(full(name), content);
    model.set(name, "file:" + content);
  }
  async function rename(from, to) {
    if (from === to || !model.has(from)) return;
    await remove(to);
    await fs.rename(full(from), full(to));
    const moved = [...model].filter(([name]) => below(from, name));
    forget(from);
    for (const [name, value] of moved) model.set(to + name.slice(from.length), value);
  }
  return async op => {
    const dir = `d${op.slot}`, other = `d${op.target}`;
    const file = path.join(dir, `f${op.target}`);
    switch (op.kind) {
      case "put": await put(file, op.value); break;
      case "removeFile": await remove(file); break;
      case "removeDir": await remove(dir); break;
      case "renameFile":
        await mkdir(other);
        await rename(file, path.join(other, `f${op.slot}`));
        break;
      case "renameDir": await rename(dir, other); break;
      case "replace": {
        // Exercise stale inode watches with activity outside the admitted Root.
        if (model.has(dir)) {
          const retired = path.join(outside, `retired-${++serial}`);
          await fs.rename(full(dir), retired); forget(dir);
          if ((await fs.stat(retired)).isDirectory()) await fs.writeFile(path.join(retired, "OUTSIDE_SENTINEL"), "outside");
        }
        await put(path.join(dir, "replacement"), op.value);
        break;
      }
      case "block":
        await remove(dir);
        await fs.writeFile(full(dir), "blocking-file");
        model.set(dir, "file:blocking-file");
        break;
      case "deep": await put(path.join(dir, "nested", ...Array(8 + op.value % 17).fill("deep"), "leaf"), op.value); break;
      case "link":
        await remove("link");
        await mkdir(dir);
        await fs.symlink(op.target % 2 ? outside : full(dir), full("link"), process.platform === "win32" ? "junction" : "dir");
        model.set("link", "symlink");
        await fs.writeFile(path.join(outside, "OUTSIDE_SENTINEL"), `outside-${++serial}`);
        break;
      case "burst":
        await mkdir(dir);
        await Promise.all(Array.from({ length: 12 }, (_, i) => put(path.join(dir, `burst${i}`), op.value + i)));
        break;
      default: throw new Error(`unknown mutation ${op.kind}`);
    }
  };
}
