import { execFile } from "node:child_process";
import path from "node:path";
import { promisify, types as utilTypes } from "node:util";
import { formatErrorDetail } from "./error-detail.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_PERMISSION_EXEC_TIMEOUT_MS = 30_000;

export type PermissionCommandFailure = {
  command: string;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
};

// Report aliases flatten these fields with Omit<..., never> to preserve consumer type queries.
export type PermissionFailureFields = {
  error?: string;
  errorDetail?: PermissionCommandFailure;
  /** Original inspection failure, retained separately from serializable diagnostics. */
  errorCause?: unknown;
};

export function formatPermissionErrorDetail(value: string): string {
  const formatted = formatErrorDetail(value);
  return formatted.length > 400 ? `${formatted.slice(0, 399)}…` : formatted;
}

const MAX_CAUGHT_FAILURE_PROTOTYPES = 4;
const primitiveString = String;
const isUint8Array = utilTypes.isUint8Array;
const Uint8ArrayIntrinsic = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(Uint8ArrayIntrinsic.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)!.get!;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const typedArraySet = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "set",
)!.value as (source: Uint8Array, offset?: number) => void;
const textDecoderDecode = TextDecoder.prototype.decode;
const stderrDecoder = new TextDecoder("utf-8", {
  fatal: false,
  ignoreBOM: true,
});
const MAX_STDERR_BYTES = 1600;

function isInspectableCaughtObject(value: unknown): value is object {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  try {
    return !utilTypes.isProxy(value);
  } catch {
    return false;
  }
}

function dataProperty(value: unknown, name: string): { value: unknown } | undefined {
  let current: unknown = value;
  for (let depth = 0; current !== null && depth < MAX_CAUGHT_FAILURE_PROTOTYPES; depth += 1) {
    if (!isInspectableCaughtObject(current)) return undefined;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, name);
    } catch {
      return undefined;
    }
    if (descriptor) {
      return Object.hasOwn(descriptor, "value") ? descriptor as { value: unknown } : undefined;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function caughtPrimitiveDisplay(value: unknown): string | undefined {
  if (value !== null && (typeof value === "object" || typeof value === "function")) return undefined;
  return primitiveString(value);
}

/** Formats only caught permission-query failures without invoking user code. */
export function formatCaughtPermissionFailure(error: unknown): string {
  const primitive = caughtPrimitiveDisplay(error);
  if (primitive !== undefined) return formatBoundedCaughtDetail(primitive);
  if (!isInspectableCaughtObject(error)) {
    return "Uninspectable proxy failure";
  }
  const message = dataProperty(error, "message");
  const name = dataProperty(error, "name");
  const rawMessage = typeof message?.value === "string"
    ? message.value : "";
  const rawName = typeof name?.value === "string"
    ? name.value : "";
  const messageText = rawMessage.slice(0, 400);
  const nameText = rawName.slice(0, 400);
  const display = messageText
    ? (nameText ? `${nameText}: ${messageText}` : messageText)
    : nameText || (typeof error === "function" ? "Unknown function failure" : "Unknown object failure");
  return formatBoundedCaughtDetail(
    display,
    rawMessage.length > messageText.length || rawName.length > nameText.length,
  );
}

function formatBoundedCaughtDetail(value: string, alreadyTruncated = false): string {
  const inputWasTruncated = alreadyTruncated || value.length > 400;
  const formatted = formatPermissionErrorDetail(value.slice(0, 400));
  if (!inputWasTruncated || formatted.endsWith("…")) return formatted;
  return `${formatted.slice(0, 399)}…`;
}

function safeStderr(value: unknown): string {
  if (typeof value === "string") return formatBoundedCaughtDetail(value);
  try {
    if (!isUint8Array(value)) return "";
    const backing = Reflect.apply(typedArrayBufferGetter, value, []) as ArrayBufferLike;
    const byteOffset = Reflect.apply(typedArrayByteOffsetGetter, value, []) as number;
    const byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
    const copiedByteLength = byteLength < MAX_STDERR_BYTES
      ? byteLength : MAX_STDERR_BYTES;
    const source = new Uint8ArrayIntrinsic(backing, byteOffset, copiedByteLength);
    const copy = new Uint8ArrayIntrinsic(copiedByteLength);
    Reflect.apply(typedArraySet, copy, [source, 0]);
    const decoded = Reflect.apply(textDecoderDecode, stderrDecoder, [copy]) as string;
    return formatBoundedCaughtDetail(decoded, byteLength > copiedByteLength);
  } catch {
    return "";
  }
}

function commandFailureFields(error: unknown) {
  const killed = dataProperty(error, "killed");
  const code = dataProperty(error, "code");
  const signal = dataProperty(error, "signal");
  const stderr = dataProperty(error, "stderr");
  return {
    found: !!(killed || code || signal || stderr),
    timedOut: killed?.value === true && signal?.value === "SIGKILL",
    exitCode: typeof code?.value === "number" ? code.value : null,
    signal: typeof signal?.value === "string" ? signal.value : null,
    stderr: stderr ? safeStderr(stderr.value) : "",
  };
}

export class PermissionCommandError extends Error implements PermissionCommandFailure {
  readonly command: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;

  constructor(
    command: string,
    durationMs: number,
    cause: unknown,
    timeoutMs = DEFAULT_PERMISSION_EXEC_TIMEOUT_MS,
  ) {
    const fields = commandFailureFields(cause);
    super(fields.timedOut
      ? `Windows permission inspection timed out after ${timeoutMs}ms`
      : `Windows permission command ${formatPermissionErrorDetail(path.win32.basename(command))} failed (exit code ${fields.exitCode}, signal ${formatPermissionErrorDetail(fields.signal ?? "none")})`,
    { cause });
    this.name = "PermissionCommandError";
    this.command = command;
    this.durationMs = Math.round(durationMs);
    this.timedOut = fields.timedOut;
    this.exitCode = fields.exitCode;
    this.signal = fields.signal;
    this.stderr = fields.stderr;
  }
}

export function getPermissionCommandFailure(
  error: unknown,
  command: string,
  durationMs: number,
): PermissionCommandFailure | undefined {
  if (isInspectableCaughtObject(error) && utilTypes.isNativeError(error)) {
    const name = dataProperty(error, "name");
    if (name?.value === "PermissionCommandError") {
      const wrappedCommand = dataProperty(error, "command");
      const wrappedDuration = dataProperty(error, "durationMs");
      const wrappedTimedOut = dataProperty(error, "timedOut");
      const wrappedExitCode = dataProperty(error, "exitCode");
      const wrappedSignal = dataProperty(error, "signal");
      const wrappedStderr = dataProperty(error, "stderr");
      if (typeof wrappedCommand?.value === "string" &&
          typeof wrappedDuration?.value === "number" &&
          Number.isSafeInteger(wrappedDuration.value) && wrappedDuration.value >= 0 &&
          typeof wrappedTimedOut?.value === "boolean" &&
          wrappedExitCode && (wrappedExitCode.value === null || typeof wrappedExitCode.value === "number") &&
          wrappedSignal && (wrappedSignal.value === null || typeof wrappedSignal.value === "string") &&
          wrappedStderr) {
        return {
          command: wrappedCommand.value,
          durationMs: wrappedDuration.value,
          timedOut: wrappedTimedOut.value,
          exitCode: wrappedExitCode.value,
          signal: wrappedSignal.value,
          stderr: safeStderr(wrappedStderr.value),
        };
      }
    }
  }
  const fields = commandFailureFields(error);
  if (!fields.found) return undefined;
  const { found: _found, ...detail } = fields;
  return { command, durationMs: Math.round(durationMs), ...detail };
}

export async function executePermissionCommand(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_PERMISSION_EXEC_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const startedAt = performance.now();
  try {
    return (await execFileAsync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    })) as { stdout: string; stderr: string };
  } catch (err) {
    throw new PermissionCommandError(command, performance.now() - startedAt, err, timeoutMs);
  }
}
