import { expect, it } from "vitest";
import {
  classifyNativeRenameFailure,
  NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH,
} from "../src/native-rename-outcome.js";

it("classifies only the internal source fence mismatch as definitely uncommitted", () => {
  expect(classifyNativeRenameFailure({ code: NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH }))
    .toBe("uncommitted");
  expect(classifyNativeRenameFailure({ code: "path-mismatch" })).toBe("indeterminate");
});
