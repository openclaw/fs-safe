import type { ExactFileIdentity } from "./exact-identity.js";

export type FastPathMode = "auto" | "never" | "require";

export type SafeEncoding = BufferEncoding | null;

export type PathStat = {
  /** Exact companion for identity checks; numeric fields are legacy metadata. */
  exactIdentity?: ExactFileIdentity;
  dev: number;
  gid: number;
  ino: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  mtimeMs: number;
  nlink: number;
  size: number;
  uid: number;
};

export type DirEntry = PathStat & {
  name: string;
};

export type BasePathOptions = {
  rootDir: string;
  relativePath: string;
};

export type { ExactFileIdentity } from "./exact-identity.js";
export type { DirectoryMode } from "./directory-mode-options.js";
