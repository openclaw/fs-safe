export const nativeTargets = [
  {
    label: "linux-x64-gnu",
    package: "@openclaw/fs-safe-linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    rust: "x86_64-unknown-linux-gnu",
    artifact: "fs-safe-native.linux-x64-gnu.node",
  },
  {
    label: "linux-x64-musl",
    package: "@openclaw/fs-safe-linux-x64-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    rust: "x86_64-unknown-linux-musl",
    artifact: "fs-safe-native.linux-x64-musl.node",
  },
  {
    label: "linux-arm64-gnu",
    package: "@openclaw/fs-safe-linux-arm64-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    rust: "aarch64-unknown-linux-gnu",
    artifact: "fs-safe-native.linux-arm64-gnu.node",
  },
  {
    label: "linux-arm64-musl",
    package: "@openclaw/fs-safe-linux-arm64-musl",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
    rust: "aarch64-unknown-linux-musl",
    artifact: "fs-safe-native.linux-arm64-musl.node",
  },
  {
    label: "darwin-x64",
    package: "@openclaw/fs-safe-darwin-x64",
    os: "darwin",
    cpu: "x64",
    rust: "x86_64-apple-darwin",
    artifact: "fs-safe-native.darwin-x64.node",
  },
  {
    label: "darwin-arm64",
    package: "@openclaw/fs-safe-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    rust: "aarch64-apple-darwin",
    artifact: "fs-safe-native.darwin-arm64.node",
  },
  {
    label: "win32-x64-msvc",
    package: "@openclaw/fs-safe-win32-x64-msvc",
    os: "win32",
    cpu: "x64",
    rust: "x86_64-pc-windows-msvc",
    artifact: "fs-safe-native.win32-x64-msvc.node",
  },
];

export function nativePackageDirectory(target) {
  return new URL(`../packages/${target.label}/`, import.meta.url);
}

export function hostNativeTarget() {
  const platformArch = `${process.platform}-${process.arch}`;
  if (platformArch === "darwin-x64" || platformArch === "darwin-arm64") {
    return nativeTargets.find((target) => target.label === platformArch);
  }
  if (platformArch === "win32-x64") {
    return nativeTargets.find((target) => target.label === "win32-x64-msvc");
  }
  if (platformArch === "linux-x64" || platformArch === "linux-arm64") {
    const libc = process.report?.getReport().header?.glibcVersionRuntime ? "gnu" : "musl";
    return nativeTargets.find((target) => target.label === `${platformArch}-${libc}`);
  }
  return undefined;
}
