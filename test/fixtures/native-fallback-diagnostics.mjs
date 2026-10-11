import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isMainThread, parentPort } from "node:worker_threads";
import * as builtConfig from "../../dist/native-config.js";
import * as builtLoader from "../../dist/native.js";
import * as builtWarnings from "../../dist/native-fallback-warning.js";

const manifest = createRequire(import.meta.url)("../../package.json");

export function nativeFallbackDiagnosticsProof({ config = builtConfig, loader = builtLoader, warning: warningModule = builtWarnings } = {}) {
  const { configureFsSafeNative, __resetFsSafeNativeConfigForTest } = config;
  const { __resetNativeLoaderForTest, __setNativeLoaderForTest, getNativeBinding,
    getNativeFallbackDiagnostic, requireNativeBinding } = loader;
  const { __resetNativeFallbackWarningsForTest, warnNativeFallback } = warningModule;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const arch = Object.getOwnPropertyDescriptor(process, "arch");
  const env = [process.env.FS_SAFE_NATIVE_MODE, process.env.OPENCLAW_FS_SAFE_NATIVE_MODE];
  const emitWarning = process.emitWarning;
  const warnings = [];
  const completed = [];
  const packageName = "@openclaw/fs-safe-win32-x64-msvc";
  const expected = `${packageName}@${manifest.optionalDependencies[packageName]}`;
  const native = { closeOwnedFd() {}, readOwnerAndDacl() {} };
  function reset() {
    delete process.env.FS_SAFE_NATIVE_MODE;
    delete process.env.OPENCLAW_FS_SAFE_NATIVE_MODE;
    __resetFsSafeNativeConfigForTest();
    __resetNativeLoaderForTest();
    __resetNativeFallbackWarningsForTest();
    warnings.length = 0;
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "arch", { value: "x64" });
  }
  function warning(reason, guidance, capability = "readOwnerAndDacl") {
    warnNativeFallback("windows-owner-dacl", "Inspection launches the packaged .NET helper for each check.", capability);
    warnNativeFallback("windows-owner-dacl", "must not warn twice", capability);
    assert.equal(warnings.length, 1);
    const [message, options] = warnings[0];
    assert.deepEqual(options, { code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning" });
    assert.match(message, new RegExp(reason));
    assert.ok(message.includes(guidance), message);
    if (reason !== "unsupported-target") assert.ok(message.includes(expected), message);
    assert.ok(message.includes("packaged .NET helper"));
    assert.doesNotMatch(message, /confidential|super-secret|\/private\/|C:\\private/);
    completed.push(reason);
    return message;
  }
  try {
    process.emitWarning = (...args) => { warnings.push(args); };
    reset();
    let loads = 0;
    __setNativeLoaderForTest(() => { loads++; return native; });
    assert.equal(getNativeFallbackDiagnostic().reason, "not-probed");
    assert.equal(loads, 0);
    assert.equal(getNativeBinding("readOwnerAndDacl"), native);
    assert.equal(getNativeFallbackDiagnostic("readOwnerAndDacl").reason, "loaded");
    assert.equal(getNativeBinding(), native);
    assert.equal(loads, 1);
    completed.push("loaded");

    for (const source of ["programmatic configuration", "FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"]) {
      reset();
      __setNativeLoaderForTest(() => assert.fail("disabled loading"));
      if (source === "programmatic configuration") {
        process.env.FS_SAFE_NATIVE_MODE = "require";
        configureFsSafeNative({ mode: "off" });
      } else {
        process.env[source] = " never ";
        if (source === "FS_SAFE_NATIVE_MODE") process.env.OPENCLAW_FS_SAFE_NATIVE_MODE = "require";
        else process.env.FS_SAFE_NATIVE_MODE = "invalid-super-secret";
      }
      assert.equal(getNativeBinding(), undefined);
      assert.deepEqual(getNativeFallbackDiagnostic(), {
        target: "win32-x64-msvc", packageName, packageVersion: manifest.optionalDependencies[packageName],
        reason: "disabled", source,
      });
      warning("disabled", source);
    }

    reset();
    let attempts = 0;
    const missing = Object.assign(new Error(`Cannot find module '${packageName}'\nRequire stack:\n/private/confidential`), { code: "MODULE_NOT_FOUND" });
    __setNativeLoaderForTest(() => { attempts++; throw missing; }, () => { throw missing; });
    assert.equal(getNativeBinding(), undefined);
    assert.equal(getNativeFallbackDiagnostic().reason, "package-missing");
    const missingMessage = warning("package-missing", "npm --include=optional");
    assert.match(missingMessage, /pnpm without --no-optional \/ optional=false/);
    assert.match(missingMessage, /lockfile and registry mirror/);
    configureFsSafeNative({ mode: "off" });
    assert.equal(getNativeFallbackDiagnostic().reason, "disabled");
    configureFsSafeNative({ mode: "require" });
    assert.throws(() => getNativeBinding(), error =>
      error.code === "helper-unavailable" && error.message === "native fs-safe helper is unavailable" && error.cause === missing);
    assert.equal(attempts, 1);
    configureFsSafeNative({ mode: "auto" });
    assert.equal(getNativeBinding(), undefined);
    assert.equal(getNativeFallbackDiagnostic().reason, "package-missing");
    assert.equal(attempts, 1);

    for (const [failure, resolver, code] of [
      [Object.assign(new Error("Cannot find module 'nested-secret'\n/private/confidential"), { code: "MODULE_NOT_FOUND" }), () => "present", "MODULE_NOT_FOUND"],
      [missing, () => "present", "MODULE_NOT_FOUND"],
      [Object.assign(new Error("C:\\private\\confidential.node: super-secret"), { code: "ERR_DLOPEN_FAILED" }), () => "present", "ERR_DLOPEN_FAILED"],
      [Object.assign(new Error("super-secret"), { code: "/private/confidential/".repeat(100) }), () => "present", "UNKNOWN"],
      ["super-secret", () => "present", "UNKNOWN"],
      [Object.defineProperty({}, "code", { get() { throw new Error("super-secret"); } }), () => "present", "UNKNOWN"],
    ]) {
      reset();
      __setNativeLoaderForTest(() => { throw failure; }, resolver);
      assert.equal(getNativeBinding(), undefined);
      assert.equal(getNativeFallbackDiagnostic().reason, "load-failed");
      assert.equal(getNativeFallbackDiagnostic().code, code);
      const message = warning("load-failed", "Reinstalling identical bytes may not help");
      assert.ok(message.includes(code));
      assert.match(message, /architecture, Linux libc compatibility/);
      assert.match(message, /OS code-integrity policy/);
      configureFsSafeNative({ mode: "require" });
      assert.throws(() => requireNativeBinding(), error => error.cause === failure && error.message === "native fs-safe helper is unavailable");
    }

    reset();
    __setNativeLoaderForTest(() => native);
    assert.equal(getNativeBinding("inspectWindowsSecureFileHandle"), undefined);
    assert.equal(getNativeFallbackDiagnostic("readOwnerAndDacl").reason, "loaded");
    assert.deepEqual(getNativeFallbackDiagnostic("inspectWindowsSecureFileHandle").capabilities, ["inspectWindowsSecureFileHandle"]);
    warning("capability-missing", "matching fs-safe and platform-package versions", "inspectWindowsSecureFileHandle");
    configureFsSafeNative({ mode: "require" });
    assert.throws(() => getNativeBinding("inspectWindowsSecureFileHandle"), {
      code: "helper-unavailable", message: "native fs-safe capabilities unavailable: inspectWindowsSecureFileHandle",
    });

    reset();
    __setNativeLoaderForTest(() => ({}));
    assert.equal(getNativeBinding(), undefined);
    assert.deepEqual(getNativeFallbackDiagnostic().capabilities, ["closeOwnedFd"]);
    warning("capability-missing", "closeOwnedFd");
    configureFsSafeNative({ mode: "require" });
    assert.throws(() => getNativeBinding(), error =>
      error.message === "native fs-safe helper is unavailable" && error.cause.message === "native descriptor ownership is unavailable");

    reset();
    Object.defineProperty(process, "platform", { value: "aix" });
    Object.defineProperty(process, "arch", { value: "ppc64" });
    assert.equal(getNativeBinding(), undefined);
    const unsupported = getNativeFallbackDiagnostic();
    assert.equal(unsupported.reason, "unsupported-target");
    assert.equal(unsupported.target, "aix-ppc64");
    assert.equal(unsupported.packageName, undefined);
    const message = warning("unsupported-target", "Portable mode is expected");
    assert.ok(message.includes(unsupported.target));
    configureFsSafeNative({ mode: "require" });
    assert.throws(() => getNativeBinding(), error => error.cause.message === "Unsupported OS or architecture: aix-ppc64");
    return completed;
  } finally {
    __resetNativeLoaderForTest();
    __resetFsSafeNativeConfigForTest();
    __resetNativeFallbackWarningsForTest();
    process.emitWarning = emitWarning;
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
    for (const [index, key] of ["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"].entries()) {
      if (env[index] === undefined) delete process.env[key];
      else process.env[key] = env[index];
    }
  }
}

if (!isMainThread) parentPort.postMessage(nativeFallbackDiagnosticsProof());
