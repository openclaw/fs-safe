import { FsSafeError } from "./errors.js";
import type { RootContext } from "./root-context.js";

const contexts = new WeakMap<object, RootContext>();
/** Internal registration; never reconstruct authority from public pathname fields. */
export function registerRootHandleContext(handle: object, context: RootContext): void {
  contexts.set(handle, context);
}
export function rootHandleContext(handle: object): RootContext {
  const context = contexts.get(handle);
  if (!context) throw new FsSafeError("invalid-path", "watch requires a genuine fs-safe Root");
  return context;
}
