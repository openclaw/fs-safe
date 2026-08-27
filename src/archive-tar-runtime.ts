import { ArchiveFormatError } from "./archive-errors.js";

export type TarParserEntry = {
  meta?: boolean;
  size: number;
  type?: string;
  resume(): void;
};

export type TarParser = NodeJS.WritableStream & {
  abort(error: Error): void;
  on(event: "ignoredEntry", listener: (entry: TarParserEntry) => void): TarParser;
  on(event: "entry", listener: (entry: TarParserEntry) => void): TarParser;
  on(event: "meta", listener: (metadata: string) => void): TarParser;
  on(event: "error", listener: (error: Error) => void): TarParser;
  on(event: "end", listener: () => void): TarParser;
};

export type TarModule = {
  Parser: new (options: { strict: true; maxMetaEntrySize: number }) => TarParser;
  x(options: {
    cwd: string;
    strip: number;
    gzip?: boolean;
    signal?: AbortSignal;
    preservePaths: false;
    noChmod: true;
    preserveOwner: false;
    noMtime: true;
    strict: true;
    maxMetaEntrySize: number;
    filter?(this: TarParser, entryPath: string, entry: unknown): boolean;
    onReadEntry(this: unknown, entry: unknown): void;
  }): TarParser;
  t(options: {
    file: string;
    strict: true;
    maxMetaEntrySize: number;
    onReadEntry(entry: AsyncIterable<unknown> & { resume(): void }): void;
  }): Promise<unknown>;
};

export async function importOptionalTar(): Promise<TarModule> {
  try {
    return await import("tar");
  } catch (cause) {
    throw new Error(
      'Optional archive dependency "tar" is not installed. Install it to use TAR archive helpers from @openclaw/fs-safe/archive.',
      { cause },
    );
  }
}

export function normalizeTarParserError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !code.startsWith("TAR_")) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ArchiveFormatError(`invalid TAR archive: ${message}`, {
    cause: error instanceof Error ? error : undefined,
  });
}
