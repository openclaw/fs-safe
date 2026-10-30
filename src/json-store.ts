import path from "node:path";
import type { DirectoryMode } from "./directory-mode-options.js";
import { fileStore } from "./file-store.js";
import {
  type JsonFileStoreOptions,
  type JsonStore,
  type JsonStoreLockOptions,
} from "./json-document-store.js";
import { admitStandalonePublicationPath, assertNoWindowsPathAlias } from "./windows-path-alias.js";

export type JsonStoreOptions<T> = JsonFileStoreOptions & {
  filePath: string;
  dirMode?: DirectoryMode;
  mode?: number;
};

export type { JsonFileStoreOptions, JsonStore, JsonStoreLockOptions };

export function jsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T> {
  const filePathInput = admitStandalonePublicationPath(options.filePath);
  const filePath = path.resolve(filePathInput);
  assertNoWindowsPathAlias(filePath);
  return fileStore({
    rootDir: path.dirname(filePath),
    private: true,
    mode: options.mode,
    dirMode: options.dirMode,
  }).json<T>(path.basename(filePath), options);
}
