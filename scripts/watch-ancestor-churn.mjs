import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const { directory, stop } = workerData;
const signal = new Int32Array(stop);
const paths = Array.from({ length: 64 }, (_, index) => path.join(directory, `branch-${index}`, "deep"));
for (const folder of paths) fs.mkdirSync(folder, { recursive: true });
parentPort.postMessage({ ready: true });
let operations = 0;
while (!Atomics.load(signal, 0)) {
  for (let index = 0; index < 8192 && !Atomics.load(signal, 0); index++) {
    const file = path.join(paths[index % paths.length], `noise-${index}`);
    fs.writeFileSync(file, String(operations));
    fs.unlinkSync(file);
    operations += 2;
  }
}
parentPort.postMessage({ operations });
