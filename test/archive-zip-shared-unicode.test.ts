import { afterEach, describe, expect, it, vi } from "vitest";
import { admitZipNames, zipExtraFields } from "../src/archive-zip-names.js";
import { unicodePath } from "./helpers/zip-records.js";

afterEach(() => vi.restoreAllMocks());

function sharedField(name: Buffer): Buffer {
  const bytes = zipExtraFields(unicodePath(name, "é")).get(0x7075)!;
  const shared = Buffer.from(new SharedArrayBuffer(bytes.length));
  bytes.copy(shared);
  return shared;
}

describe("shared ZIP Unicode metadata", () => {
  for (const sameField of [true, false]) {
    const label = sameField ? "the same shared field" : "distinct equal shared fields";

    function fixture() {
      const central = Buffer.from("name");
      const centralField = sharedField(central);
      const localField = sameField ? centralField : sharedField(central);
      return {
        centralField,
        localField,
        admit: () => admitZipNames({
          central,
          local: Buffer.from(central),
          flags: 0,
          centralExtra: new Map([[0x7075, centralField]]),
          localExtra: new Map([[0x7075, localField]]),
          seen: new Set(),
        }),
      };
    }

    it(`accepts unchanged Unicode metadata in ${label}`, () => {
      expect(fixture().admit()).toEqual({ path: "é", portableKey: "é", portableDirectory: false, directory: false });
    });

    it(`revalidates local CRC after central decoding with ${label}`, () => {
      const { admit, centralField, localField } = fixture();
      const decode = TextDecoder.prototype.decode;
      let changed = false;
      vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args) {
        const decoded = Reflect.apply(decode, this, args);
        if (!changed) {
          changed = true;
          // With flags=0, this first decode reads central Unicode metadata.
          // Model a concurrent writer changing both CRCs while keeping them equal.
          centralField[1] ^= 1;
          if (localField !== centralField) localField[1] ^= 1;
        }
        return decoded;
      });
      expect(admit).toThrow(expect.objectContaining({
        code: "archive-header-invalid",
        message: "invalid ZIP metadata: Unicode Path CRC mismatch",
      }));
    });
  }
});
