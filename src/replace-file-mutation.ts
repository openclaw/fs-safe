import type { BigIntStats } from "node:fs";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";

export type ReplaceFileAtomicDestinationState =
  | Readonly<{ state: "removed"; path: string }>
  | Readonly<{ state: "writing" | "published"; path: string; dev: bigint; ino: bigint }>;

export type AtomicMutationOptions = {
  /** Recheck live authority before new effects; retained descriptor completion may settle. */
  assertBeforeMutation?: () => void;
  /** Retain observed destination facts even when later completion fails. */
  onDestinationState?: (state: ReplaceFileAtomicDestinationState) => void;
};

export class AtomicMutation {
  readonly active: boolean;
  readonly #assertion: AtomicMutationOptions["assertBeforeMutation"];
  readonly #observer: AtomicMutationOptions["onDestinationState"];
  #refusal: { error: unknown } | undefined;
  #writingReported = false;

  constructor(options: AtomicMutationOptions) {
    this.#assertion = options.assertBeforeMutation;
    this.#observer = options.onDestinationState;
    this.active = Boolean(this.#assertion || this.#observer);
  }

  rethrowRefusal(): void {
    if (this.#refusal) throw this.#refusal.error;
  }

  refuse(error: unknown): never {
    this.#refusal ??= { error };
    throw this.#refusal.error;
  }

  #invoke(operation: () => unknown, name: string): void {
    this.rethrowRefusal();
    try {
      const result = operation();
      assertSynchronousCallbackResult(result, name);
    } catch (error) {
      this.refuse(error);
    }
  }

  assert(): void {
    this.#invoke(() => this.#assertion?.(), "assertBeforeMutation");
  }

  destination(state: "writing" | "published", path: string, identity: BigIntStats): void {
    if (state === "writing") {
      if (this.#writingReported) return;
      this.#writingReported = true;
    }
    this.#invoke(() => this.#observer?.(Object.freeze({
      state, path, dev: identity.dev, ino: identity.ino,
    })), "onDestinationState");
  }

  removed(path: string): void {
    this.#invoke(() => this.#observer?.(Object.freeze({ state: "removed", path })), "onDestinationState");
  }
}
