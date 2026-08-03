import fs from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { ArchiveFormatError } from "./archive-errors.js";
import { ARCHIVE_LIMIT_ERROR_CODE, ArchiveLimitError } from "./archive-limits.js";

type MeterState =
  | { kind: "header" }
  | { kind: "data"; remaining: number }
  | { kind: "sparse"; dataRemaining: number; metaBytes: number };

class TarMetadataMeter extends Transform {
  private readonly block = Buffer.alloc(512);
  private blockLength = 0;
  private state: MeterState = { kind: "header" };

  constructor(private readonly maxMetaEntryBytes: number) {
    super();
  }

  private invalid(message: string): ArchiveFormatError {
    return new ArchiveFormatError(`invalid TAR header: ${message}`);
  }

  private parseSize(): number {
    const field = this.block.subarray(124, 136);
    if ((field[0] ?? 0) & 0x80) {
      if (field[0] !== 0x80) {
        throw this.invalid("base-256 size is negative or malformed");
      }
      let value = 0n;
      for (const byte of field.subarray(1)) {
        value = (value << 8n) | BigInt(byte);
      }
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw this.invalid("base-256 size exceeds the safe integer range");
      }
      return Number(value);
    }
    const zero = field.indexOf(0);
    const text = field.subarray(0, zero < 0 ? field.length : zero).toString("ascii").trim();
    if (!text || !/^[0-7]+$/.test(text)) throw this.invalid("size is not valid octal");
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value)) throw this.invalid("octal size exceeds the safe integer range");
    return value;
  }

  private finishHeader(): void {
    if (this.block.every((byte) => byte === 0)) {
      this.blockLength = 0;
      this.state = { kind: "header" };
      return;
    }
    const size = this.parseSize();
    const type = this.block[156];
    if ([0x78, 0x67, 0x4c, 0x4b, 0x58].includes(type ?? -1) && size > this.maxMetaEntryBytes) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.META_ENTRY_SIZE_EXCEEDS_LIMIT);
    }
    if (type === 0x78 || type === 0x67 || type === 0x58) {
      throw this.invalid("PAX metadata is unmeterable without interpreting content");
    }
    const padded = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(padded)) throw this.invalid("entry padding exceeds the safe integer range");
    if (type === 0x53) {
      if (this.block[482] !== 0 && this.block[482] !== 1) {
        throw this.invalid("GNU sparse extension flag is not 0 or 1");
      }
      if (this.block[482] === 0) {
        throw this.invalid("GNU sparse entries are not supported");
      }
      this.state = { kind: "sparse", dataRemaining: padded, metaBytes: 0 };
    } else {
      this.state = padded === 0 ? { kind: "header" } : { kind: "data", remaining: padded };
    }
    this.blockLength = 0;
  }

  private finishSparseHeader(state: Extract<MeterState, { kind: "sparse" }>): void {
    const metaBytes = state.metaBytes + 512;
    if (metaBytes > this.maxMetaEntryBytes) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.META_ENTRY_SIZE_EXCEEDS_LIMIT);
    }
    if (this.block[504] !== 0 && this.block[504] !== 1) {
      throw this.invalid("GNU sparse extension flag is not 0 or 1");
    }
    if (this.block[504] === 1) {
      this.state = { ...state, metaBytes };
    } else {
      throw this.invalid("GNU sparse entries are not supported");
    }
    this.blockLength = 0;
  }

  private meter(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.state.kind === "data") {
        const take = Math.min(this.state.remaining, chunk.length - offset);
        offset += take;
        const remaining = this.state.remaining - take;
        this.state = remaining === 0 ? { kind: "header" } : { kind: "data", remaining };
        continue;
      }
      const take = Math.min(512 - this.blockLength, chunk.length - offset);
      chunk.copy(this.block, this.blockLength, offset, offset + take);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 512) {
        if (this.state.kind === "sparse") this.finishSparseHeader(this.state);
        else this.finishHeader();
      }
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    try {
      this.meter(chunk);
      callback(null, chunk);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (this.state.kind === "header" && this.blockLength === 0) callback();
    else callback(this.invalid(this.state.kind === "header" ? "truncated TAR header" : "truncated TAR entry"));
  }
}

async function isGzip(filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const magic = Buffer.alloc(2);
    const { bytesRead } = await handle.read(magic, 0, 2, 0);
    return bytesRead === 2 && magic[0] === 0x1f && magic[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

export async function preflightTarMetadata(params: {
  archivePath: string;
  maxMetaEntryBytes: number;
  signal?: AbortSignal;
}): Promise<void> {
  const input = fs.createReadStream(params.archivePath);
  const meter = new TarMetadataMeter(params.maxMetaEntryBytes);
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  if (await isGzip(params.archivePath)) {
    await pipeline(input, createGunzip(), meter, sink, { signal: params.signal });
  } else {
    await pipeline(input, meter, sink, { signal: params.signal });
  }
}
