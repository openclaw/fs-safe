// Node 26 adds two internal promises per async lstat/stat, including FileHandle.stat.
// Count only the known metadata operations; retain exact operation-level bounds.
export function metadataPromiseOverhead(count) {
  return Number(process.versions.node.split(".")[0]) >= 26 ? 2 * count : 0;
}
