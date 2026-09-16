import { describe, expect } from "vitest";
import { itPosix } from "./helpers/vitest.js";
import { exactTempStat, secureTempAdapterFixture, tempError } from "./helpers/secure-temp-adapter.js";

describe("secure-temp repair races and failures", () => {
  itPosix("rejects a safe replacement between initial admission and descriptor open", () => {
    const f = secureTempAdapterFixture();
    f.lstatSync.mockImplementationOnce(() => {
      const admitted = { ...f.state.named };
      f.state.named = exactTempStat(18n, 0o40700n);
      return admitted;
    });
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.openSync).not.toHaveBeenCalled();
    expect(f.fchmodSync).not.toHaveBeenCalled();
  });

  itPosix("rejects a replacement opened instead of the admitted object", () => {
    const f = secureTempAdapterFixture();
    f.openSync.mockImplementation(() => {
      f.state.named = exactTempStat(18n);
      f.state.pinned = f.state.named;
      return 42;
    });
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.fchmodSync).not.toHaveBeenCalled();
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  itPosix("rejects a bigint identity mismatch even when numeric identities collide", () => {
    const f = secureTempAdapterFixture();
    f.state.named.ino = 9007199254740992n;
    f.fstatSync.mockImplementation(() => ({ ...f.state.pinned, ino: 9007199254740993n }));
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.fchmodSync).not.toHaveBeenCalled();
    expect(f.closeSync).toHaveBeenCalledTimes(1);
  });

  itPosix.each(["before-chmod", "chmod", "warning", "access"])("preserves a replacement introduced at %s and refuses the path", (stage) => {
    const f = secureTempAdapterFixture();
    const original = f.state.named;
    const replacement = exactTempStat(18n);
    if (stage === "before-chmod") {
      let reads = 0;
      f.lstatSync.mockImplementation(() => {
        const observed = { ...f.state.named };
        if (++reads === 3) f.state.named = replacement;
        return observed;
      });
    } else if (stage === "chmod") {
      f.fchmodSync.mockImplementation(() => {
        f.state.named = replacement;
        f.state.pinned.mode = 0o40700n;
      });
    } else if (stage === "warning") {
      f.warn.mockImplementation(() => { f.state.named = replacement; });
    } else {
      f.accessSync.mockImplementation(() => { f.state.named = replacement; });
    }
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(original.mode).toBe(0o40700n);
    expect(replacement.mode).toBe(0o40777n);
    expect(f.fchmodSync).toHaveBeenCalledExactlyOnceWith(42, 0o700);
    expect(f.chmodSync).not.toHaveBeenCalled();
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  itPosix.each(["EPERM", "EACCES", "ENOENT"])("accepts same-object concurrent repair after %s without warning", (code) => {
    const f = secureTempAdapterFixture();
    f.fchmodSync.mockImplementation(() => {
      f.state.pinned.mode = 0o40700n;
      throw tempError(code);
    });
    expect(f.resolve()).toBe(f.candidate);
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.accessSync).toHaveBeenCalledTimes(1);
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  itPosix("does not adopt a safe replacement after a denied chmod", () => {
    const f = secureTempAdapterFixture();
    f.fchmodSync.mockImplementation(() => {
      f.state.named = exactTempStat(18n, 0o40700n);
      throw tempError("EPERM");
    });
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.state.pinned.mode).toBe(0o40777n);
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.closeSync).toHaveBeenCalledTimes(1);
  });

  itPosix.each(["mode", "access", "owner"])("rejects an unsuccessful final %s check", (failure) => {
    const f = secureTempAdapterFixture();
    if (failure === "mode") f.fchmodSync.mockImplementation(() => undefined);
    if (failure === "access") f.accessSync.mockImplementation(() => { throw tempError("EACCES"); });
    if (failure === "owner") f.warn.mockImplementation(() => { f.state.pinned.uid = 502n; });
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  itPosix("retains admission and close failures beneath the ordinary public Error", () => {
    const f = secureTempAdapterFixture();
    const admission = new Error("fstat denied");
    const close = new Error("close denied");
    f.fstatSync.mockImplementation(() => { throw admission; });
    f.closeSync.mockImplementation(() => { throw close; });
    let failure: Error | undefined;
    try { f.resolve(); } catch (error) { failure = error as Error; }
    expect(failure?.constructor).toBe(Error);
    expect(failure?.cause).toBeInstanceOf(AggregateError);
    expect((failure?.cause as AggregateError).errors).toEqual([admission, close]);
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  itPosix("fails closed on a lone close error without retrying close", () => {
    const f = secureTempAdapterFixture();
    const close = new Error("close denied");
    f.closeSync.mockImplementation(() => { throw close; });
    let failure: Error | undefined;
    try { f.resolve(); } catch (error) { failure = error as Error; }
    expect(failure?.cause).toBe(close);
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  itPosix("does not forgive an unrelated chmod failure even if the object becomes safe", () => {
    const f = secureTempAdapterFixture();
    const error = tempError("EIO");
    f.fchmodSync.mockImplementation(() => { f.state.pinned.mode = 0o40700n; throw error; });
    let failure: Error | undefined;
    try { f.resolve(); } catch (cause) { failure = cause as Error; }
    expect(failure?.cause).toBe(error);
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  itPosix("preserves chmod and unsuccessful concurrent-repair verification failures", () => {
    const f = secureTempAdapterFixture();
    const chmod = tempError("EPERM");
    f.fchmodSync.mockImplementation(() => { throw chmod; });
    let failure: Error | undefined;
    try { f.resolve(); } catch (error) { failure = error as Error; }
    expect(failure?.cause).toBeInstanceOf(AggregateError);
    expect((failure?.cause as AggregateError).errors[0]).toBe(chmod);
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  itPosix.each(["symlink", "foreign"])("does not trust a recursive-mkdir winner that is %s", (winner) => {
    const f = secureTempAdapterFixture();
    f.state.exists = false;
    f.mkdirSync.mockImplementation(() => {
      f.state.exists = true;
      f.state.named = exactTempStat();
      if (winner === "symlink") f.state.named.isSymbolicLink = () => true;
      else f.state.named.uid = 502n;
    });
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.openSync).not.toHaveBeenCalled();
    expect(f.fchmodSync).not.toHaveBeenCalled();
    expect(f.chmodSync).not.toHaveBeenCalled();
  });
});
