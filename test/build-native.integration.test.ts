import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.runIf(process.platform === "win32")("resolves real Cargo member-local flags from the native working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "fs-safe-cargo-member-"));
  try {
    const scripts = join(root, "scripts");
    const native = join(root, "native");
    mkdirSync(scripts);
    mkdirSync(join(root, ".cargo"));
    mkdirSync(join(native, ".cargo"), { recursive: true });
    for (const file of ["build-native.mjs", "native-targets.mjs", "windows-runtime.mjs"]) {
      copyFileSync(new URL(`../scripts/${file}`, import.meta.url), join(scripts, file));
    }
    cpSync(new URL("../scripts/cargo-rustflags", import.meta.url), join(scripts, "cargo-rustflags"), { recursive: true });
    writeFileSync(join(root, ".cargo", "config.toml"), '[build]\nrustflags = ["--cfg", "fs_safe_root_flags"]\n');
    writeFileSync(join(native, ".cargo", "config.toml"), '[build]\nrustflags = ["--cfg", "fs_safe_member_flags"]\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]
        .includes(key.toUpperCase()) && !/^CARGO_TARGET_.*_RUSTFLAGS$/u.test(key.toUpperCase())));
    env.CARGO_HOME = join(root, "cargo-home");
    const { windowsNativeBuildEnv } = await import(pathToFileURL(join(scripts, "build-native.mjs")).href);
    const flags = windowsNativeBuildEnv(process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc",
      env).CARGO_ENCODED_RUSTFLAGS.split("\x1f");
    expect(flags).toContain("fs_safe_root_flags");
    expect(flags).toContain("fs_safe_member_flags");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
