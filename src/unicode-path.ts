const NON_ASCII = /[^\x00-\x7f]/;

export function lowerCaseNfc(value: string): string {
  return NON_ASCII.test(value) ? value.normalize("NFC").toLowerCase().normalize("NFC") : value.toLowerCase();
}

export function maxNormalizedUtf8Bytes(value: string): number {
  const nfc = value.normalize("NFC");
  const bytes = Buffer.byteLength(nfc, "utf8");
  // ASCII NFC output also has identical NFD and one UTF-8 byte per code unit.
  if (bytes === nfc.length) return bytes;
  return Math.max(
    bytes,
    Buffer.byteLength(value.normalize("NFD"), "utf8"),
  );
}
