import { expect, it } from "vitest";
import { NATIVE_NOREPLACE_UNSUPPORTED } from "../src/native-noreplace.js";
import {
  classifyNativeRenameFailure,
  NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH,
} from "../src/native-rename-outcome.js";

it("classifies explicit source-fence and unsupported-capability provenance as uncommitted", () => {
  expect(classifyNativeRenameFailure({ code: NATIVE_NOREPLACE_UNSUPPORTED })).toBe("uncommitted");
  expect(classifyNativeRenameFailure({ code: NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH }))
    .toBe("uncommitted");
  expect(classifyNativeRenameFailure({ code: "path-mismatch" })).toBe("indeterminate");
});

it.each([
  "EACCES", "EBADF", "EBUSY", "EEXIST", "EINVAL", "EISDIR", "ELOOP", "EMLINK",
  "ENAMETOOLONG", "ENOENT", "ENOSPC", "ENOSYS", "ENOTDIR", "ENOTEMPTY", "ENOTSUP",
  "EOPNOTSUPP", "EPERM", "EROFS", "ETXTBSY", "EXDEV", "EIO", undefined,
])("does not infer rename commit state from ordinary errno %s", code => {
  expect(classifyNativeRenameFailure({ code })).toBe("indeterminate");
});
