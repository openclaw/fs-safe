import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isMainThread, parentPort } from "node:worker_threads";
import * as publicConfig from "../../dist/config.js";
import { __resetFsSafeNativeConfigForTest } from "../../dist/native-config.js";
import * as builtLoader from "../../dist/native.js";

const builtConfig = { ...publicConfig, __resetFsSafeNativeConfigForTest };
const manifest = createRequire(import.meta.url)("../../package.json");

export async function nativeStatusProof({ config = builtConfig, loader = builtLoader } = {}) {
  const { configureFsSafeNative, getFsSafeNativeConfig, getFsSafeNativeStatus,
    __resetFsSafeNativeConfigForTest } = config;
  const { __setNativeLoaderForTest, __resetNativeLoaderForTest, getNativeBinding } = loader;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const arch = Object.getOwnPropertyDescriptor(process, "arch");
  const env = [process.env.FS_SAFE_NATIVE_MODE, process.env.OPENCLAW_FS_SAFE_NATIVE_MODE];
  const results = [];
  const packageName = "@openclaw/fs-safe-win32-x64-msvc";
  function reset() {
    __resetFsSafeNativeConfigForTest();
    __resetNativeLoaderForTest();
    delete process.env.FS_SAFE_NATIVE_MODE;
    delete process.env.OPENCLAW_FS_SAFE_NATIVE_MODE;
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "arch", { value: "x64" });
  }
  async function report(reason, probe = false) {
    const before = getFsSafeNativeConfig();
    const value = await getFsSafeNativeStatus({ probe });
    assert.deepEqual(getFsSafeNativeConfig(), before);
    assert.equal(value.reason, reason);
    assert.equal(value.loaded, reason === "loaded");
    assert.deepEqual(Object.keys(value).sort(), ["mode", "modeSource", "reason", "loaded", "target",
      ...(value.target === "aix-ppc64" ? [] : ["packageName", "packageVersion"]),
      ...(reason === "load-failed" ? ["loadErrorCode"] : []),
      ...(["loaded", "not-probed"].includes(reason) ? [] : ["guidance"])].sort());
    assert.doesNotMatch(JSON.stringify(value), /private|confidential|super-secret|closeOwnedFd|readOwnerAndDacl|C:\\/);
    if (value.target !== "aix-ppc64") {
      assert.equal(value.packageName, packageName);
      assert.equal(value.packageVersion, manifest.optionalDependencies[packageName]);
    }
    results.push(value);
    return value;
  }
  try {
    reset();
    let loads = 0;
    const native = { closeOwnedFd() {} };
    __setNativeLoaderForTest(() => { loads++; return native; });
    assert.equal((await report("not-probed")).modeSource, "default");
    assert.equal(loads, 0);
    await report("not-probed");
    assert.equal(loads, 0);
    await report("loaded", true);
    assert.equal(getNativeBinding(), native);
    assert.equal(loads, 1);
    // Per-operation capability failure does not downgrade the core loader status.
    assert.equal(getNativeBinding("readOwnerAndDacl"), undefined);
    await report("loaded");
    configureFsSafeNative({ mode: "off" });
    await report("disabled", true);
    configureFsSafeNative({ mode: "auto" });
    await report("loaded", true);
    assert.equal(loads, 1);

    for (const source of ["programmatic configuration", "FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"]) {
      reset();
      let disabledLoads = 0;
      __setNativeLoaderForTest(() => { disabledLoads++; return native; });
      if (source === "programmatic configuration") {
        process.env.FS_SAFE_NATIVE_MODE = "require";
        configureFsSafeNative({ mode: "off" });
      } else {
        process.env[source] = " never ";
        if (source === "FS_SAFE_NATIVE_MODE") process.env.OPENCLAW_FS_SAFE_NATIVE_MODE = "require";
        else process.env.FS_SAFE_NATIVE_MODE = "invalid-super-secret";
      }
      assert.equal((await report("disabled", true)).modeSource, source);
      assert.equal(disabledLoads, 0);
    }

    for (const resolved of [false, true]) {
      reset();
      const failure = Object.assign(new Error(`Cannot find module '${packageName}'\nRequire stack:\n/private/confidential`), { code: "MODULE_NOT_FOUND" });
      __setNativeLoaderForTest(() => { throw failure; }, () => {
        if (resolved) return "/private/confidential";
        throw failure;
      });
      await report(resolved ? "load-failed" : "package-missing", true);
    }
    reset();
    const nested = Object.assign(new Error("Cannot find module 'nested-dependency'\n/private/confidential"), { code: "MODULE_NOT_FOUND" });
    __setNativeLoaderForTest(() => { throw nested; }, () => { assert.fail("nested failure must not resolve the platform package"); });
    assert.equal((await report("load-failed", true)).loadErrorCode, "MODULE_NOT_FOUND");

    for (const code of ["ERR_DLOPEN_FAILED", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND",
      "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_INVALID_PACKAGE_CONFIG", "EACCES", "EPERM", "ENOENT", "/private/confidential", undefined]) {
      reset();
      let repaired = false;
      let failureLoads = 0;
      const failure = Object.assign(new Error("/private/confidential"), { code });
      __setNativeLoaderForTest(() => {
        failureLoads++;
        if (repaired) return native;
        throw failure;
      });
      configureFsSafeNative({ mode: "require" });
      assert.equal((await report("load-failed", true)).loadErrorCode, code === undefined || code.startsWith("/") ? "UNKNOWN" : code);
      repaired = true;
      await report("load-failed", true);
      assert.equal(failureLoads, 1);
      assert.throws(() => getNativeBinding(), error => error.cause === failure);
    }
    reset();
    __setNativeLoaderForTest(() => { throw { get code() { throw new Error("/private/confidential"); } }; });
    assert.equal((await report("load-failed", true)).loadErrorCode, "UNKNOWN");

    reset();
    __setNativeLoaderForTest(() => ({}));
    await report("capability-missing", true);
    configureFsSafeNative({ mode: "require" });
    assert.throws(() => getNativeBinding(), error => error.cause?.code === "helper-unavailable");
    await report("capability-missing");

    reset();
    Object.defineProperty(process, "platform", { value: "aix" });
    Object.defineProperty(process, "arch", { value: "ppc64" });
    assert.equal((await report("not-probed")).target, "aix-ppc64");
    configureFsSafeNative({ mode: "require" });
    assert.equal((await report("unsupported-target", true)).target, "aix-ppc64");
    return results;
  } finally {
    __resetNativeLoaderForTest();
    __resetFsSafeNativeConfigForTest();
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
    for (const [index, key] of ["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"].entries()) {
      if (env[index] === undefined) delete process.env[key];
      else process.env[key] = env[index];
    }
  }
}

if (!isMainThread) parentPort.postMessage(await nativeStatusProof());
