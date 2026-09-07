import fs from "node:fs";
import {
  ROOT_PATH_ALIAS_POLICIES,
  resolveRootPath,
  type RootPathAliasPolicy,
} from "./root-path.js";
import { isNotFoundPathError } from "./path.js";
import { shortPath } from "./error-detail.js";

export type PathAliasPolicy = RootPathAliasPolicy;

export const PATH_ALIAS_POLICIES = ROOT_PATH_ALIAS_POLICIES;

export async function assertNoPathAliasEscape(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  policy?: PathAliasPolicy;
}): Promise<void> {
  const resolved = await resolveRootPath({
    absolutePath: params.absolutePath,
    rootPath: params.rootPath,
    boundaryLabel: params.boundaryLabel,
    policy: params.policy,
  });
  const allowFinalSymlink = params.policy?.allowFinalSymlinkForUnlink === true;
  if (allowFinalSymlink && resolved.kind === "symlink") {
    return;
  }
  await assertNoHardlinkedFinalPath({
    filePath: resolved.canonicalPath,
    root: resolved.rootPath,
    boundaryLabel: params.boundaryLabel,
    allowFinalHardlinkForUnlink: params.policy?.allowFinalHardlinkForUnlink,
  });
}

export async function assertNoHardlinkedFinalPath(params: {
  filePath: string;
  root: string;
  boundaryLabel: string;
  allowFinalHardlinkForUnlink?: boolean;
}): Promise<void> {
  if (params.allowFinalHardlinkForUnlink) {
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(params.filePath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return;
    }
    throw err;
  }
  if (!stat.isFile()) {
    return;
  }
  if (stat.nlink > 1) {
    throw new Error(
      `Hardlinked path is not allowed under ${params.boundaryLabel} (${shortPath(params.root)}): ${shortPath(params.filePath)}`,
    );
  }
}
