import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { root } from "../../dist/root.js";
import { configureFsSafeNative } from "../../dist/native-config.js";

configureFsSafeNative({ mode: "require" });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-write-fds-"));
const summarize = error => error && ({
  name: error.name, code: error.code, message: error.message, category: error.category,
  details: error.details, cause: summarize(error.cause),
  error: summarize(error.error), suppressed: summarize(error.suppressed),
});
const results = [];
try {
  const scoped = await root(directory);
  await scoped.write("warm", "warm");
  fs.unlinkSync(path.join(directory, "warm"));
  for (let spare = 0; spare <= 8; spare++) {
    const filler = [];
    let failure;
    try {
      try { for (;;) filler.push(fs.openSync("/dev/null", "r")); }
      catch (error) { if (error.code !== "EMFILE") throw error; }
      for (let index = 0; index < spare; index++) fs.closeSync(filler.pop());
      try { await scoped.write("output", "complete contents"); }
      catch (error) { failure = error; }
    } finally {
      for (const fd of filler) fs.closeSync(fd);
    }
    const files = fs.readdirSync(directory);
    results.push({ spare, failure: summarize(failure), files,
      contents: files.map(name => fs.readFileSync(path.join(directory, name), "utf8")) });
    for (const name of files) fs.unlinkSync(path.join(directory, name));
  }
  console.log(JSON.stringify(results));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
