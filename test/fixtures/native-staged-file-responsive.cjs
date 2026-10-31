const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const native = require(process.argv[2]);
const operation = process.argv[3];
const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fs-safe-stage-responsive-"));
const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const fifo = path.join(directory, "blocker");
execFileSync("mkfifo", [fifo]);
fs.writeFileSync(path.join(directory, "source"), "complete bytes");
// One libuv worker is held in a real blocking open. Only the JS timer can
// release it; a staged syscall must queue behind it without freezing that timer.
const blocker = new Promise((resolve, reject) => fs.open(fifo, "r", (error, fd) => {
  if (error) reject(error);
  else { fs.closeSync(fd); resolve(); }
}));
let released = false, completedBeforeRelease;
const pending = Promise.resolve(operation === "create"
  ? native.createStagedFile(parent, "stage")
  : (native[`${operation}Async`] ?? native[operation])(parent, "source", parent, "final"))
  .then(result => { completedBeforeRelease = !released; return result; });
setTimeout(() => {
  released = true;
  fs.closeSync(fs.openSync(fifo, "w"));
}, 10);
Promise.all([pending, blocker]).then(([fd]) => {
  if (operation === "create") native.closeOwnedFd(fd);
  assert.equal(completedBeforeRelease, false, `${operation} ran on the JS thread instead of the occupied libuv pool`);
  if (operation !== "create") assert.equal(fs.readFileSync(path.join(directory, "final"), "utf8"), "complete bytes");
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.closeSync(parent);
  fs.rmSync(directory, { recursive: true, force: true });
});
