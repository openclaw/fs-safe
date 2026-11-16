import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(join(process.argv[2], "package.json"));
const loaded = new Set();
const hooks = registerHooks({
  load(url, context, nextLoad) {
    loaded.add(url);
    return nextLoad(url, context);
  },
});
const surfaces = [];
try {
  for (const subpath of ["file-identity", "file-io", "regular-file", "root-path"]) {
    const entry = require.resolve(`@openclaw/fs-safe/${subpath}`);
    surfaces.push(await import(pathToFileURL(entry).href));
  }
} finally {
  hooks.deregister();
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
