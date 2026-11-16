import assert from "node:assert/strict";

const windowsRuntimeFlags = ["-Ctarget-feature=+crt-static", "-Clink-arg=/NODEFAULTLIB:libucrt.lib", "-Clink-arg=ucrt.lib"];

export function windowsRuntimeEnv(inherited) {
  const env = Object.fromEntries(Object.entries(inherited).map(([key, value]) =>
    [process.platform === "win32" ? key.toUpperCase() : key, value]));
  // Cargo gives encoded flags precedence, including an explicitly empty value.
  if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS, ...windowsRuntimeFlags].filter(Boolean).join("\x1f");
  } else env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} ${windowsRuntimeFlags.join(" ")}`.trim();
  return env;
}

// Adapted from proc-safe's hybrid CRT admission; signed certificate overlays are
// outside the mapped image and do not change the import tables.
function inspectWindowsRuntime(binary, cpu, managed) {
  const check = (condition, message) => assert.ok(condition, `Invalid Windows binary: ${message}`);
  const range = (offset, size, limit = binary.length) => {
    check(Number.isSafeInteger(offset) && offset >= 0 && size >= 0 && offset + size <= limit, "truncated PE data");
  };
  range(0, 64);
  check(binary.readUInt16LE(0) === 0x5a4d, "missing DOS signature");
  const pe = binary.readUInt32LE(60);
  range(pe, 24);
  check(pe >= 64 && binary.readUInt32LE(pe) === 0x4550, "missing PE signature");
  const machine = binary.readUInt16LE(pe + 4);
  check((managed && machine === 0x14c) || (!managed && ((cpu === "x64" && machine === 0x8664) ||
    (cpu === "arm64" && machine === 0xaa64))), `wrong machine for ${managed ? "AnyCPU" : cpu}`);
  check(((binary.readUInt16LE(pe + 22) & 0x2000) !== 0) === !managed, managed ? "expected an executable" : "expected a DLL");
  const optional = pe + 24;
  const optionalSize = binary.readUInt16LE(pe + 20);
  range(optional, optionalSize);
  const directoryOffset = managed ? 96 : 112;
  check(optionalSize >= directoryOffset && binary.readUInt16LE(optional) === (managed ? 0x10b : 0x20b),
    managed ? "expected PE32" : "expected PE32+");
  const imageSize = binary.readUInt32LE(optional + 56);
  const headerSize = binary.readUInt32LE(optional + 60);
  const directories = binary.readUInt32LE(optional + directoryOffset - 4);
  check(directories <= 16 && directoryOffset + directories * 8 <= optionalSize, "invalid data directories");
  const sectionCount = binary.readUInt16LE(pe + 6);
  const sectionTable = optional + optionalSize;
  check(sectionCount > 0 && sectionTable + sectionCount * 40 <= headerSize, "invalid section table");
  range(0, headerSize);
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const entry = sectionTable + index * 40;
    const rva = binary.readUInt32LE(entry + 12);
    const size = binary.readUInt32LE(entry + 16);
    const offset = binary.readUInt32LE(entry + 20);
    range(offset, size);
    check(rva + size <= imageSize, "section outside image");
    if (size) sections.push({ rva, size, offset });
  }
  const span = (rva, size) => {
    check(rva > 0 && rva + size <= imageSize, "RVA outside image");
    if (rva < headerSize) {
      range(rva, size, headerSize);
      return { offset: rva, available: headerSize - rva };
    }
    const matches = sections.filter(section => rva >= section.rva && rva - section.rva < section.size);
    check(matches.length === 1, "unmapped or ambiguous RVA");
    const section = matches[0];
    const available = section.size - (rva - section.rva);
    check(size <= available, "RVA exceeds section data");
    return { offset: section.offset + rva - section.rva, available };
  };
  const dllName = rva => {
    const { offset, available } = span(rva, 1);
    const end = binary.indexOf(0, offset);
    check(end > offset && end < offset + available, "unterminated DLL name");
    const bytes = binary.subarray(offset, end);
    check(bytes.every(byte => byte >= 0x21 && byte <= 0x7e), "invalid DLL name");
    const name = bytes.toString("ascii").toLowerCase();
    check(!/[\\/:]/.test(name) && name.endsWith(".dll"), "invalid DLL name");
    return name;
  };
  const directory = index => {
    if (index >= directories) return { rva: 0, size: 0 };
    const entry = optional + directoryOffset + index * 8;
    return { rva: binary.readUInt32LE(entry), size: binary.readUInt32LE(entry + 4) };
  };
  const imports = (index, stride, nameOffset, delay = false) => {
    const { rva, size } = directory(index);
    if (rva === 0 && size === 0) return [];
    check(rva !== 0 && size >= stride, "invalid import directory");
    const { offset } = span(rva, size);
    const names = [];
    for (let current = offset; current + stride <= offset + size; current += stride) {
      if (binary.subarray(current, current + stride).every(byte => byte === 0)) return names;
      if (delay) check(binary.readUInt32LE(current) === 1, "invalid delay-import attributes");
      names.push(dllName(binary.readUInt32LE(current + nameOffset)));
    }
    check(false, "unterminated import directory");
  };
  const direct = imports(1, 20, 12);
  const delayed = imports(13, 32, 4, true);
  const dependencies = [...new Set([...direct, ...delayed])].sort();
  const external = dependencies.filter(name => /^(?:vcruntime|msvcp|msvcr|concrt|vcomp|vccorlib)\d.*\.dll$|^ucrtbased\.dll$/.test(name));
  assert.equal(external.length, 0, `Windows binary requires a VC redistributable: ${external.join(", ")}`);
  const clr = directory(14);
  if (managed) {
    check(clr.rva !== 0 && clr.size >= 72, "missing CLR header");
    const { offset } = span(clr.rva, clr.size);
    check(binary.readUInt32LE(offset) >= 72 && binary.readUInt32LE(offset) <= clr.size, "invalid CLR header");
    const flags = binary.readUInt32LE(offset + 16);
    check((flags & 1) !== 0 && (flags & (2 | 0x10 | 0x20000)) === 0, "expected IL-only AnyCPU helper");
    check(binary.readUInt32LE(offset + 12) >= 4, "truncated CLR metadata");
    const metadata = span(binary.readUInt32LE(offset + 8), binary.readUInt32LE(offset + 12));
    check(binary.readUInt32LE(metadata.offset) === 0x424a5342, "invalid CLR metadata");
    check(direct.includes("mscoree.dll"), "missing OS CLR loader");
  } else {
    check(clr.rva === 0 && clr.size === 0, "expected a native addon");
    assert.ok(dependencies.some(name => name === "ucrtbase.dll" || /^api-ms-win-crt-[\w-]+\.dll$/.test(name)),
      "Windows addon must use the OS-provided UCRT");
  }
  return { cpu: managed ? "anycpu" : cpu, imports: [...new Set(direct)].sort(), delayImports: [...new Set(delayed)].sort() };
}

export const verifyWindowsRuntime = (binary, cpu) => inspectWindowsRuntime(binary, cpu, false);
export const verifyWindowsHelper = binary => inspectWindowsRuntime(binary, undefined, true);
