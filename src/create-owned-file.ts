import fs from "node:fs";

export type OwnedFileDescriptorSync = {
  readonly fd: number;
  close(): void;
  [Symbol.dispose](): void;
};

/** Capture the descriptor's creator-owned closer before it can be reused. */
export function ownFileDescriptorSync(
  fd: number,
  closeFd: (fd: number) => void = fs.closeSync,
): OwnedFileDescriptorSync {
  let open = true;
  const owner: OwnedFileDescriptorSync = {
    fd,
    close() {
      if (!open) return;
      open = false;
      closeFd(fd);
    },
    [Symbol.dispose]() { owner.close(); },
  };
  return Object.freeze(owner);
}
