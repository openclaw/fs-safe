import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";
import { MutationAuthorityError } from "./mutation-authority.js";
import type { PinnedWriteInput } from "./pinned-write.js";
import type { RootCreateOptions, RootCreateStreamOptions, RootWriteOptions } from "./root-options.js";

// Lock records need exclusive creation, not private-before-visible publication.
// Keep this composition hook off the public Root options and package exports.
const exclusiveSidecarCreate = Symbol("exclusiveSidecarCreate");
export const sidecarExclusiveCreate = Object.freeze({ [exclusiveSidecarCreate]: true as const });

export type RootWriteParams = RootWriteOptions & RootCreateStreamOptions & {
  relativePath: string;
  data: string | Buffer | AsyncIterable<Uint8Array>;
  [exclusiveSidecarCreate]?: true;
};

class CreateInputError extends FsSafeError {
  constructor(readonly rejection: unknown) {
    super("helper-failed", "create input failed", { cause: rejection });
  }
}

export function rethrowCreateInputError(error: unknown): never {
  if (error instanceof CreateInputError) throw error.rejection;
  throw error;
}

export function createInputOptions(
  data: RootWriteParams["data"],
  options: RootCreateOptions & RootCreateStreamOptions,
  defaultMaxBytes?: number,
): RootCreateOptions & RootCreateStreamOptions {
  if (typeof data === "string" || Buffer.isBuffer(data)) return options;
  options.signal?.throwIfAborted();
  if (options.encoding !== undefined || options.renameIdentity !== undefined) {
    throw new TypeError("streamed create does not accept encoding or renameIdentity");
  }
  const maxBytes = normalizeMaxBytes(options.maxBytes, { defaultValue: defaultMaxBytes });
  return {
    ...options,
    maxBytes,
    assertBeforeMutation: () => {
      options.signal?.throwIfAborted();
      return options.assertBeforeMutation?.();
    },
  };
}

export function rootWriteInput(params: RootWriteParams): PinnedWriteInput {
  const data = params.data;
  if (typeof data === "string" || Buffer.isBuffer(data)) {
    return { kind: "buffer", data, encoding: params.encoding, stageBeforePublish: !params[exclusiveSidecarCreate] };
  }
  return {
    kind: "stream",
    stageBeforePublish: true,
    stream: (async function* () {
      let iterator: AsyncIterator<Uint8Array> | undefined;
      let completed = false;
      try {
        params.signal?.throwIfAborted();
        iterator = data[Symbol.asyncIterator]();
        while (true) {
          if (params.signal?.aborted) throw new MutationAuthorityError(params.signal.reason);
          const next = await iterator.next();
          completed = next.done === true;
          if (params.signal?.aborted) throw new MutationAuthorityError(params.signal.reason);
          if (completed) return;
          const chunk = next.value;
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError("streamed create chunks must be Uint8Array values");
          }
          yield chunk;
        }
      } catch (error) {
        if (error instanceof MutationAuthorityError) throw error;
        throw new CreateInputError(error);
      } finally {
        if (iterator && !completed) {
          try {
            await iterator.return?.();
          } catch (error) {
            throw new CreateInputError(error);
          }
        }
      }
    })(),
  };
}
