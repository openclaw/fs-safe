import path from "node:path";
import { fileStore } from "./file-store.js";
import {
  type JsonFileStoreOptions,
  type JsonStore,
  type JsonStoreLockOptions,
} from "./json-document-store.js";

export type JsonStoreOptions<T> = JsonFileStoreOptions & {
  filePath: string;
  dirMode?: number;
  mode?: number;
};

export type { JsonFileStoreOptions, JsonStore, JsonStoreLockOptions };

export function jsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T> {
  const filePath = path.resolve(options.filePath);
  return fileStore({
    rootDir: path.dirname(filePath),
    private: true,
    mode: options.mode,
    dirMode: options.dirMode,
  }).json<T>(path.basename(filePath), options);
}
