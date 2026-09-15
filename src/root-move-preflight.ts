import {
  assertMutationNotDenied,
  type DenyMutationPolicy,
} from "./deny-mutations.js";
import { resolvePathInRoot, type RootContext } from "./root-context.js";

export async function assertMoveMutationAllowed(
  root: RootContext,
  params: {
    fromRelative: string;
    toRelative: string;
    denyMutations?: DenyMutationPolicy;
  },
): Promise<void> {
  // Keep this preflight separate from the pinned resolutions in movePathFallback:
  // mutation denials must take precedence over source alias or identity failures.
  const source = await resolvePathInRoot(root, params.fromRelative, {
    aliasErrorCode: "path-alias",
    allowFinalSymlink: true,
  });
  await assertMutationNotDenied(source.resolved, params.denyMutations, { protectAncestors: true });
  const target = await resolvePathInRoot(root, params.toRelative, {
    aliasErrorCode: "path-alias",
    allowFinalSymlink: true,
  });
  await assertMutationNotDenied(target.resolved, params.denyMutations, { protectAncestors: true });
}
