export {
  tempWorkspace,
  type TempWorkspace,
  type TempWorkspaceOptions,
  type TempWorkspaceCleanupMechanism,
  type TempWorkspaceCleanupResult,
  type TempWorkspaceCleanupSafety,
  tempWorkspaceSync,
  type TempWorkspaceSync,
  withTempWorkspace,
  withTempWorkspaceSync,
} from "./private-temp-workspace.js";
export type { TempPathIdentityReceipt } from "./temp-cleanup.js";
export {
  resolveSecureTempRoot,
  type ResolveSecureTempRootOptions,
  type SecureTempRootDescriptorAdapter,
} from "./secure-temp-dir.js";
