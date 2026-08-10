import fs from "node:fs";

type ReadOpenFlagConstants = Pick<typeof fs.constants, "O_RDONLY"> &
  Partial<Pick<typeof fs.constants, "O_NOFOLLOW" | "O_NONBLOCK">>;

export function resolveReadOpenFlags(options?: {
  constants?: ReadOpenFlagConstants;
  followSymlinks?: boolean;
}): number {
  const constants = options?.constants ?? fs.constants;
  const noFollow =
    process.platform !== "win32" &&
    options?.followSymlinks !== true &&
    typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0;
  const nonBlocking =
    process.platform !== "win32" && typeof constants.O_NONBLOCK === "number"
      ? constants.O_NONBLOCK
      : 0;
  return constants.O_RDONLY | noFollow | nonBlocking;
}
