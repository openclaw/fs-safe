import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(join(process.argv[2], "package.json"));
const loaded = new Set();
const surfaces = [];
const session = new Session();
session.connect();
try {
  // The inspector reports parsed ESM scripts on every supported Node 22 release.
  session.on("Debugger.scriptParsed", ({ params }) => loaded.add(params.url));
  await session.post("Debugger.enable");
  for (const subpath of ["file-identity", "file-io", "regular-file", "root-path"]) {
    const entry = pathToFileURL(require.resolve(`@openclaw/fs-safe/${subpath}`)).href;
    surfaces.push(await import(entry));
    assert.ok(loaded.has(entry), `did not observe the ${subpath} entry`);
  }
} finally {
  session.disconnect();
}

const rootImplementation = pathToFileURL(require.resolve("@openclaw/fs-safe/root"));
rootImplementation.pathname = rootImplementation.pathname.replace(/\/root\.js$/, "/root-impl.js");
assert.ok(!loaded.has(rootImplementation.href), "focused imports loaded the full Root implementation");

const advanced = await import(pathToFileURL(require.resolve("@openclaw/fs-safe/advanced")).href);
for (const surface of surfaces) {
  for (const [name, value] of Object.entries(surface)) {
    assert.equal(value, advanced[name], `${name} must retain its existing implementation`);
  }
}
console.log("focused package imports preserve existing exports without loading Root");
