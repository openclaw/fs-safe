export function windowsPe(cpu: "x64" | "arm64" | "anycpu", direct = [cpu === "anycpu" ? "mscoree.dll" : "ucrtbase.dll"], delayed: string[] = []) {
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(cpu === "anycpu" ? 0x14c : cpu === "x64" ? 0x8664 : 0xaa64, 132);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148);
  bytes.writeUInt16LE(cpu === "anycpu" ? 2 : 0x2002, 150);
  const optional = 152;
  bytes.writeUInt16LE(cpu === "anycpu" ? 0x10b : 0x20b, optional);
  bytes.writeUInt32LE(8192, optional + 56);
  bytes.writeUInt32LE(512, optional + 60);
  const directories = cpu === "anycpu" ? 96 : 112;
  bytes.writeUInt32LE(16, optional + directories - 4);
  bytes.writeUInt32LE(4096, 404);
  bytes.writeUInt32LE(3584, 408);
  bytes.writeUInt32LE(512, 412);
  let nameOffset = 2048;
  for (const [directory, tableOffset, stride, nameField, names] of [
    [1, 512, 20, 12, direct], [13, 1024, 32, 4, delayed],
  ] as const) {
    if (!names.length) continue;
    bytes.writeUInt32LE(tableOffset + 3584, optional + directories + directory * 8);
    bytes.writeUInt32LE((names.length + 1) * stride, optional + directories + 4 + directory * 8);
    for (const [index, name] of names.entries()) {
      const descriptor = tableOffset + index * stride;
      if (directory === 13) bytes.writeUInt32LE(1, descriptor);
      bytes.writeUInt32LE(nameOffset + 3584, descriptor + nameField);
      bytes.write(name, nameOffset, "ascii");
      nameOffset += name.length + 1;
    }
  }
  if (cpu === "anycpu") {
    bytes.writeUInt32LE(1536 + 3584, optional + directories + 14 * 8);
    bytes.writeUInt32LE(72, optional + directories + 14 * 8 + 4);
    bytes.writeUInt32LE(72, 1536);
    bytes.writeUInt32LE(1664 + 3584, 1544);
    bytes.writeUInt32LE(4, 1548);
    bytes.writeUInt32LE(1, 1552);
    bytes.writeUInt32LE(0x424a5342, 1664);
  }
  return bytes;
}

export function certificateOverlay(bytes: Buffer) {
  const result = Buffer.concat([bytes, Buffer.alloc(32, 0x5a)]);
  const directories = bytes.readUInt16LE(152) === 0x10b ? 96 : 112;
  result.writeUInt32LE(bytes.length, 152 + directories + 4 * 8);
  result.writeUInt32LE(32, 152 + directories + 4 * 8 + 4);
  return result;
}
