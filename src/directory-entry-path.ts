import path from "node:path";

/** Strip only trailing separators: lstat must inspect the entry, not follow a leaf link. */
export function directoryEntryPath(dir: string, platform = process.platform): string {
  const windows = platform === "win32";
  if (typeof dir === "string") {
    const last = dir[dir.length - 1];
    if (last !== "/" && (!windows || last !== "\\")) return dir;
  }
  let rootLength = (windows ? path.win32 : path.posix).parse(dir).root.length;
  if (windows && /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(dir)) {
    // Node parses the namespace prefix as the root; retain the complete UNC share.
    const uncRoot = path.win32.parse(`\\\\${dir.slice(8)}`).root;
    if (uncRoot.length > 1) rootLength = Math.max(rootLength, uncRoot.length + 6);
  }
  let end = dir.length;
  while (end > rootLength && (dir[end - 1] === "/" || (windows && dir[end - 1] === "\\"))) end--;
  return end === rootLength || end === dir.length ? dir : dir.slice(0, end);
}
