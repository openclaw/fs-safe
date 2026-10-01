import fsSync from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import type { NativeBinding } from "../../src/native.js";

export const FALSY_FAILURES = [undefined, null, false, 0, -0, 0n, "", Number.NaN] as const;

type Failure = { enabled: true; value: unknown } | { enabled: false };
type Settlement = { failed: true; value: unknown } | { failed: false };
type FileOperation =
  | { kind: "identity" }
  | { kind: "write" | "metadata"; value: unknown };

export const noFailure: Failure = { enabled: false };
export const fails = (value: unknown): Failure => ({ enabled: true, value });

export function pathKey(value: fsSync.PathLike): string {
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function bindHandle(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof FileHandle];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function capture(run: () => Promise<unknown>): Promise<Settlement> {
  try {
    await run();
    return { failed: false };
  } catch (value) {
    return { failed: true, value };
  }
}

export function expectFailure(settlement: Settlement, expected: unknown): void {
  expect(settlement.failed).toBe(true);
  if (settlement.failed) expect(Object.is(settlement.value, expected)).toBe(true);
}

type FilePlan = {
  path: string;
  operation?: FileOperation;
  closeFailure?: Failure | (() => Failure);
  beforeClose?(): Promise<void>;
  onCloseStart?(): void;
  onClosed?(): void;
};

export function observeFileHandles(plans: FilePlan[]) {
  const byPath = new Map(plans.map(plan => [pathKey(plan.path), plan]));
  const attempts = new Map<string, number>();
  const events: string[] = [];
  const open = fsp.open.bind(fsp);
  vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const plan = byPath.get(pathKey(args[0]));
    if (!plan) return handle;
    const overrides: Partial<FileHandle> = {};
    const operation = plan.operation;
    if (operation?.kind === "identity") {
      overrides.stat = (async () => {
        const stat = await handle.stat({ bigint: true });
        return new Proxy(stat, {
          get(target, property) {
            if (property === "ino") return target.ino + 1n;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as FileHandle["stat"];
    } else if (operation?.kind === "write") {
      overrides.write = (async () => {
        throw operation.value;
      }) as FileHandle["write"];
    } else if (operation?.kind === "metadata") {
      overrides.utimes = async () => {
        throw operation.value;
      };
    }
    overrides.close = async () => {
      const key = pathKey(plan.path);
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      events.push(key);
      plan.onCloseStart?.();
      await plan.beforeClose?.();
      await handle.close();
      plan.onClosed?.();
      const configuredFailure = plan.closeFailure;
      const failure = typeof configuredFailure === "function"
        ? configuredFailure()
        : configuredFailure ?? noFailure;
      if (failure.enabled) throw failure.value;
    };
    return bindHandle(handle, overrides);
  });
  return {
    attempts: (filename: string) => attempts.get(pathKey(filename)) ?? 0,
    events,
  };
}

type DirectoryRole = {
  label: string;
  path: string;
  occurrence?: number;
  failure?: Failure;
};

export function observeDirectoryCloses(roles: DirectoryRole[]) {
  const open = fsSync.openSync.bind(fsSync);
  const close = fsSync.closeSync.bind(fsSync);
  const occurrences = new Map<string, number>();
  const descriptors = new Map<number, DirectoryRole>();
  const attempts = new Map<string, number>();
  const events: string[] = [];
  vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
    const fd = open(...args);
    descriptors.delete(fd);
    const key = pathKey(args[0]);
    const matching = roles.filter(role => pathKey(role.path) === key);
    if (matching.length > 0) {
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      const role = matching.find(candidate => candidate.occurrence === undefined || candidate.occurrence === occurrence);
      if (role) descriptors.set(fd, role);
    }
    return fd;
  }) as typeof fsSync.openSync);
  vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
    const role = descriptors.get(fd);
    if (role) {
      attempts.set(role.label, (attempts.get(role.label) ?? 0) + 1);
      events.push(role.label);
    }
    close(fd);
    if (!role) return;
    const failure = role.failure ?? noFailure;
    if (failure.enabled) throw failure.value;
  });
  return {
    attempts: (label: string) => attempts.get(label) ?? 0,
    events,
  };
}

export function portableRoles(
  directory: string,
  source: string,
  destination: string,
  failures: Partial<Record<string, Failure>> = {},
): DirectoryRole[] {
  return [
    { label: "parent", path: directory, occurrence: 1, failure: failures.parent },
    { label: "wrapper-original", path: source, occurrence: 1, failure: failures["wrapper-original"] },
    { label: "portable-target", path: destination, occurrence: 1, failure: failures["portable-target"] },
    { label: "portable-original", path: source, occurrence: 2, failure: failures["portable-original"] },
  ];
}

export function fakeNative(
  probe: NativeBinding["probeTreeClone"],
  clone: NativeBinding["cloneTree"],
): NativeBinding {
  return {
    closeOwnedFd() {},
    probeTreeClone: probe,
    cloneTree: clone,
  } as NativeBinding;
}
