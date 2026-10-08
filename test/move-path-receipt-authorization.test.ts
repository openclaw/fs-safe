import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { movePathWithCopyFallback, type MovePathPublicationReceipt } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe("direct move receipt after authorization", () => {
  it.each(["assertBeforeRename", "assertBeforeMutation"] as const)(
    "captures the source selected by %s",
    async assertion => {
      const directory = await tempRoot("fs-safe-move-receipt-authority-");
      const source = path.join(directory, "source");
      const target = path.join(directory, "target");
      const parked = path.join(directory, "parked");
      await fs.writeFile(source, "first");
      const first = fsSync.lstatSync(source, { bigint: true });
      let receipt: MovePathPublicationReceipt | undefined;
      await movePathWithCopyFallback({
        from: source,
        to: target,
        [assertion]: () => {
          fsSync.renameSync(source, parked);
          fsSync.writeFileSync(source, "selected");
        },
        onDestinationPublished: published => { receipt = published; },
      });
      const selected = fsSync.lstatSync(target, { bigint: true });
      expect(selected.ino).not.toBe(first.ino);
      expect(receipt).toEqual({ path: target, dev: selected.dev, ino: selected.ino });
      expect(await fs.readFile(target, "utf8")).toBe("selected");
      expect(await fs.readFile(parked, "utf8")).toBe("first");
    },
  );
});
