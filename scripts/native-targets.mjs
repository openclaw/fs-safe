export const nativeTargets = [
  {
    label: "linux-x64-gnu",
    rust: "x86_64-unknown-linux-gnu",
    artifact: "fs-safe-native.linux-x64-gnu.node",
  },
  {
    label: "linux-x64-musl",
    rust: "x86_64-unknown-linux-musl",
    artifact: "fs-safe-native.linux-x64-musl.node",
  },
  {
    label: "linux-arm64-gnu",
    rust: "aarch64-unknown-linux-gnu",
    artifact: "fs-safe-native.linux-arm64-gnu.node",
  },
  {
    label: "linux-arm64-musl",
    rust: "aarch64-unknown-linux-musl",
    artifact: "fs-safe-native.linux-arm64-musl.node",
  },
  {
    label: "darwin-x64",
    rust: "x86_64-apple-darwin",
    artifact: "fs-safe-native.darwin-x64.node",
  },
  {
    label: "darwin-arm64",
    rust: "aarch64-apple-darwin",
    artifact: "fs-safe-native.darwin-arm64.node",
  },
  {
    label: "win32-x64-msvc",
    rust: "x86_64-pc-windows-msvc",
    artifact: "fs-safe-native.win32-x64-msvc.node",
  },
];

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
