import JSZip from "jszip";

export async function createZipEndScanFixture(shape) {
  const zip = new JSZip();
  const payload = shape === "comment" ? Buffer.from("payload") : Buffer.alloc(64 * 1024,
    shape === "dense-payload" ? Buffer.from([0x50, 0x4b, 0x05, 0x06]) : 0x61);
  // A live DOS timestamp can complete a false end record in the dense payload.
  zip.file("payload.bin", payload, { date: new Date("2000-01-01T00:00:00Z") });
  if (shape === "comment") zip.comment = "a".repeat(65_535);
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}
