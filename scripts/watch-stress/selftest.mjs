import { assert, fs, path, fixture, observe, cleanup } from "./oracle.mjs";
import { getNativeBinding } from "../../dist/native.js";

// Prove a checkpoint cannot repair corruption without an invalidation. Suppress
// native hints only in this calibration, leaving explicit guarded reconcile real.
export async function selftest() {
  const f = await fixture("oracle-selftest"), binding = getNativeBinding(), original = binding.watchRegister;
  let observer;
  binding.watchRegister = (directory, limit) => original(directory, limit, () => {});
  try {
    await fs.mkdir(path.join(f.directory, "child"));
    await fs.writeFile(path.join(f.directory, "child", "file"), "initial");
    await fs.writeFile(path.join(f.directory, "sibling"), "kept");
    observer = observe(f); await observer.subscription.ready; await observer.checkpoint();
    observer.cache.set("sibling", "deliberate-corruption");
    await assert.rejects(observer.checkpoint(), /consumer cache diverged/);
    await fs.writeFile(path.join(f.directory, "sibling"), "changed"); await observer.checkpoint();
    await fs.rm(path.join(f.directory, "child"), { recursive: true }); await observer.checkpoint();
    await fs.mkdir(path.join(f.directory, "new-child"));
    await fs.writeFile(path.join(f.directory, "new-child", "new-file"), "new"); await observer.checkpoint();
    return { staleCacheDetected: true, creationModificationDeletion: true, ...observer.metrics };
  } finally { binding.watchRegister = original; await cleanup([() => observer?.close()], [() => f.remove()]); }
}
