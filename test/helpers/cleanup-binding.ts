import { vi } from "vitest";

export function mockCleanupBinding(probe: ReturnType<typeof vi.fn> | undefined) {
  return {
    closeOwnedFd: vi.fn(),
    renameNoReplace: vi.fn(),
    removeOwnedTree: vi.fn(),
    removeOwnedTreeSync: vi.fn(),
    ownedTreeRemovalAvailable: probe,
  };
}
