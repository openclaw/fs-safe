// This facade drives the same cache without constructing a watch subscription.
// Its notifications are explicit workload signals, never watcher correctness proof.
export function manualInvalidations(_capability, options) {
  let closed = false, timer, pending = false, detail;
  const emit = reason => {
    clearTimeout(timer); timer = undefined;
    if (closed || !pending) return;
    pending = false;
    const changes = detail; detail = undefined;
    options.onInvalidate({ reason, changes });
  };
  const ready = Promise.resolve().then(() => {
    pending = true; emit("reconcile");
  });
  return {
    ready,
    health: () => ({ state: closed ? "closed" : "ready", mode: "manual-control" }),
    mark(changes) {
      if (closed) return;
      detail = pending ? undefined : changes;
      pending = true;
      timer ??= setTimeout(() => emit("event"), 25);
    },
    async reconcile() { emit("reconcile"); },
    async close() { closed = true; clearTimeout(timer); pending = false; },
  };
}
