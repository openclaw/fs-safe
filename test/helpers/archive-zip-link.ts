import assert from "node:assert/strict";
import JSZip from "jszip";

export async function zipDirectoryLinkFixture(form: "trailing-slash" | "dos-directory") {
  const name = form === "trailing-slash" ? "link/" : "link";
  const target = "../outside";
  const zip = new JSZip();
  zip.file("keep.txt", "keep");
  zip.file(name, target, { unixPermissions: 0o120777, createFolders: false });
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "STORE" });

  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 10), 2);
  let central = bytes.readUInt32LE(end + 16);
  for (const expectedName of ["keep.txt", name]) {
    assert.equal(bytes.readUInt32LE(central), 0x02014b50);
    const nameLength = bytes.readUInt16LE(central + 28);
    assert.equal(bytes.toString("utf8", central + 46, central + 46 + nameLength), expectedName);
    const local = bytes.readUInt32LE(central + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 26), nameLength);
    assert.equal(bytes.toString("utf8", local + 30, local + 30 + nameLength), expectedName);
    if (expectedName === name) {
      assert.equal(bytes[central + 5], 3); // Unix creator: retain the symlink mode.
      assert.equal(bytes.readUInt32LE(central + 38), 0xa1ff0000);
      // Setting dosPermissions through JSZip would append a slash and erase the payload.
      if (form === "dos-directory") bytes.writeUInt32LE(0xa1ff0010, central + 38);
      assert.equal(bytes.readUInt32LE(central + 38), form === "dos-directory" ? 0xa1ff0010 : 0xa1ff0000);
      assert.equal(bytes.readUInt32LE(central + 24), Buffer.byteLength(target));
    }
    central += 46 + nameLength + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32);
  }
  assert.equal(central, end);

  // Both load as directories, but the raw local/central names above must stay distinct.
  const loaded = await JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(loaded.files), ["keep.txt", "link/"]);
  assert.equal(loaded.files["link/"].dir, true);
  assert.equal(loaded.files["link/"].unixPermissions, 0o120777);
  return { bytes, name, size: Buffer.byteLength(target) };
}
