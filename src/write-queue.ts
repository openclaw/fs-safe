const writeQueues = new Map<string, Promise<void>>();

export async function serializePathWrite<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const task = previous.then(() => run());
  const done = task.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, done);
  try {
    return await task;
  } finally {
    if (writeQueues.get(key) === done) {
      writeQueues.delete(key);
    }
  }
}
