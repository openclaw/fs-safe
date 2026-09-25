/** Only these runtimes use native directory recursion, not per-file JS watches. */
export function nativeRecursiveWatchPlatform(platform: string): boolean {
  return platform === "darwin" || platform === "win32";
}

// Fixed program, no interpolated paths/code. It only registers advisory directory
// hints; all path admission and authoritative observation stay in guarded scans.
export const nodeWatchProgram = String.raw`
(async () => {
// Dynamic imports work with both CommonJS and inherited --input-type=module.
// Keep inherited runtime/security flags intact rather than clearing execArgv.
const { parentPort, workerData } = await import('node:worker_threads');
const { watch } = await import('node:fs');
const windowsNames = workerData.platform === 'win32';
const separator = windowsNames ? String.fromCharCode(92) : '/';
const watches = new Map();
let outstanding = false;
let hints = new Map();
let overflow = false;
let failed = false;
let closing = false;
const closeErrors = [];
function send() {
  if (closing || failed || outstanding || (!overflow && hints.size === 0)) return;
  outstanding = true;
  parentPort.postMessage({ type: 'dirty', hints: [...hints.values()], overflow });
  hints.clear();
  overflow = false;
}
function dirty(directory, event, name) {
  if (closing || failed) return;
  if (workerData.recursiveRoot && typeof name === 'string') {
    const parts = (windowsNames ? name.replaceAll(String.fromCharCode(92), '/') : name).split('/');
    if (name.includes(String.fromCharCode(0)) || parts.some(part => !part || part === '.' || part === '..' || (windowsNames && part.includes(':')))) {
      directory = ''; name = null;
    } else {
      name = parts.pop(); directory = parts.join(separator);
    }
  }
  if (!overflow) {
    if (hints.size >= workerData.maxPendingPaths) { hints.clear(); overflow = true; }
    else {
      const key = JSON.stringify([directory, name]);
      const prior = hints.get(key);
      hints.set(key, { directory, event: prior?.event === "rename" ? "rename" : event, name });
    }
  }
  send();
}
function failure(error) {
  if (closing) { closeErrors.push({ message: error.message, code: error.code }); return; }
  if (failed) return;
  failed = true;
  parentPort.postMessage({ type: 'error', message: error.message, code: error.code });
}
parentPort.on('message', command => {
  if (command.type === 'close') {
    if (closing) return;
    closing = true;
    // Bun's watch manager is process-global. Detach our registrations explicitly;
    // a joined JS worker does not own the runtime's shared driver descriptor.
    for (const handle of watches.values()) {
      try { handle.close(); }
      catch (error) { closeErrors.push({ message: error.message, code: error.code }); }
    }
    watches.clear(); hints.clear();
    parentPort.postMessage({ type: 'closed', errors: closeErrors });
    parentPort.close();
    return;
  }
  if (closing) return;
  if (command.type === 'ack') {
    outstanding = false;
    send();
    return;
  }
  if (failed) return;
  try {
    if (command.type === 'add') {
      const handle = watch(command.path, { recursive: workerData.recursiveRoot }, (event, name) => dirty(command.relative, event, name));
      watches.set(command.path, handle);
      handle.on('error', failure);
    }
    parentPort.postMessage({ type: 'reply', id: command.id });
  } catch (error) { failure(error); }
});
})();
`;
