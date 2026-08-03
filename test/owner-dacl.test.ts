import { afterEach, describe, expect, it } from "vitest";
import { itPosix } from "./helpers/vitest.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";

function withProcessPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("process.platform descriptor missing");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe("readOwnerAndDacl", () => {
  itPosix("returns a typed unsupported result off Windows", () => {
    expect(readOwnerAndDacl("/tmp/example")).toEqual({
      status: "unsupported-platform",
      platform: process.platform,
    });
  });

  itPosix("returns ACE facts without applying trust policy", () => {
    __setNativeLoaderForTest(
      () =>
        ({
          readOwnerAndDacl: () => ({
            ownerSid: "s-1-5-21-owner",
            currentUserSid: "s-1-5-21-current-user",
            ownerClass: "foreign",
            worldWritable: true,
            groupWritable: true,
            worldReadable: true,
            groupReadable: true,
            fallbackRequired: false,
            daclPresent: true,
            isLocal: true,
            aceListComplete: true,
            unsupportedAceTypes: [],
            aces: [
              {
                sid: "s-1-5-21-trusted",
                mask: 0x120089,
                aceType: "allow",
                flags: {
                  raw: 8,
                  objectInherit: false,
                  containerInherit: false,
                  noPropagateInherit: false,
                  inheritOnly: true,
                  inherited: false,
                  successfulAccess: false,
                  failedAccess: false,
                },
              },
            ],
          }),
        }) as unknown as NativeBinding,
    );

    const result = withProcessPlatform("win32", () => readOwnerAndDacl("C:\\staging"));
    expect(result).toEqual({
      status: "supported",
      ownerSid: "s-1-5-21-owner",
      currentUserSid: "s-1-5-21-current-user",
      daclPresent: true,
      isLocal: true,
      complete: true,
      unsupportedAceTypes: [],
      aces: [
        expect.objectContaining({
          sid: "s-1-5-21-trusted",
          mask: 0x120089,
          aceType: "allow",
          flags: expect.objectContaining({ inheritOnly: true }),
        }),
      ],
    });
  });
});
