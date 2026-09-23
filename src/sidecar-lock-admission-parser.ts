import type { Root } from "./root-impl.js";
import type { HeldSidecarLock } from "./sidecar-lock-admission.js";
import {
  parseSidecarLockSnapshot,
  readSidecarLockRawSnapshot,
  type SidecarLockSnapshot,
} from "./sidecar-lock-reclaim.js";

export type SidecarAdmissionRunner = {
  hasToken(): boolean;
  run<T>(callback: () => T): T;
};

export function runSidecarAdmissionBoundary<T>(
  admission: SidecarAdmissionRunner,
  assertCurrent: () => void,
  callback: () => T,
): T {
  assertCurrent();
  try {
    return admission.run(callback);
  } finally {
    assertCurrent();
  }
}

export async function awaitSidecarAdmissionBoundary<T>(
  admission: SidecarAdmissionRunner,
  assertCurrent: () => void,
  callback: () => T | PromiseLike<T>,
): Promise<{ readonly value: Awaited<T> }> {
  assertCurrent();
  try {
    return await admission.run(async () => {
      const boxed = Object.create(null) as { value: Awaited<T> | undefined };
      Object.defineProperty(boxed, "value", {
        value: undefined, enumerable: true, writable: true,
      });
      boxed.value = await callback();
      return boxed as { readonly value: Awaited<T> };
    });
  } finally {
    assertCurrent();
  }
}

export type SidecarLockParserState = {
  observed: boolean;
  parser?: (raw: string) => unknown;
};

export function observeSidecarLockParser(
  state: SidecarLockParserState,
  admission: SidecarAdmissionRunner,
  accessor: () => ((raw: string) => unknown) | undefined,
  assertCurrent: () => void,
): void {
  assertCurrent();
  if (state.observed) return;
  try {
    state.parser = admission.run(accessor);
  } finally {
    assertCurrent();
  }
  state.observed = true;
}

export function scopedSidecarLockParser(
  state: SidecarLockParserState,
  admission: SidecarAdmissionRunner,
  assertCurrent: () => void,
): ((raw: string) => unknown) | undefined {
  const parser = state.parser;
  return parser && ((raw) => admission.run(() => {
    assertCurrent();
    try {
      return Reflect.apply(parser, undefined, [raw]);
    } finally {
      assertCurrent();
    }
  }));
}

/** Cleanup may outlive its reservation; never invoke user code after authority is lost. */
export function conditionalSidecarLockParser(
  state: SidecarLockParserState,
  admission: SidecarAdmissionRunner,
  isCurrent: () => boolean,
): ((raw: string) => unknown) | undefined {
  const parser = state.parser;
  return parser && ((raw) => {
    if (!isCurrent()) return undefined;
    return admission.run(() => {
      if (!isCurrent()) return undefined;
      let parsed: unknown;
      try {
        parsed = Reflect.apply(parser, undefined, [raw]);
      } catch (error) {
        if (!isCurrent()) return undefined;
        throw error;
      }
      return isCurrent() ? parsed : undefined;
    });
  });
}

export function parseSidecarLockSnapshotUnderAdmission(
  raw: Awaited<ReturnType<typeof readSidecarLockRawSnapshot>>,
  state: SidecarLockParserState,
  admission: SidecarAdmissionRunner,
  assertCurrent: () => void,
): SidecarLockSnapshot | null {
  return parseSidecarLockSnapshot(raw, scopedSidecarLockParser(state, admission, assertCurrent));
}

export type HeldSidecarParserObservation =
  | { kind: "observed" }
  | { kind: "holder-changed" }
  | { kind: "read-error"; error: unknown; transientDenial: boolean };

/** Emulate the historical EEXIST read/parser boundary without opening another sidecar. */
export async function observeHeldSidecarParser(params: {
  admission: SidecarAdmissionRunner;
  assertToken(): void;
  currentHeld(): HeldSidecarLock | undefined;
  held: HeldSidecarLock;
  lockPath: string;
  lockRoot?: Root;
  parserState: SidecarLockParserState;
  parserAccessor(): ((raw: string) => unknown) | undefined;
  isTransientDenial(error: unknown): boolean;
}): Promise<HeldSidecarParserObservation> {
  const holderChanged = {};
  const assertCurrentHolder = () => {
    params.assertToken();
    if (params.currentHeld() !== params.held || params.held.releasePromise) {
      throw holderChanged;
    }
  };
  let transientDenial = false;
  let raw: Awaited<ReturnType<typeof readSidecarLockRawSnapshot>>;
  try {
    raw = await params.admission.run(async () => await readSidecarLockRawSnapshot(
      params.lockPath,
      {
        lockRoot: params.lockRoot,
        rejectNonFile: true,
        discardObservation: "changed",
        onOpenFailure: (error) => { transientDenial = params.isTransientDenial(error); },
      },
    ));
  } catch (error) {
    return { kind: "read-error", error, transientDenial };
  }
  params.assertToken();
  if (params.currentHeld() !== params.held || params.held.releasePromise) {
    return { kind: "holder-changed" };
  }
  try {
    observeSidecarLockParser(
      params.parserState,
      params.admission,
      params.parserAccessor,
      assertCurrentHolder,
    );
    parseSidecarLockSnapshotUnderAdmission(
      raw,
      params.parserState,
      params.admission,
      assertCurrentHolder,
    );
    assertCurrentHolder();
  } catch (error) {
    if (error === holderChanged) return { kind: "holder-changed" };
    throw error;
  }
  return { kind: "observed" };
}
