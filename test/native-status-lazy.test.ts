import { expect, it, vi } from "vitest";
import { getFsSafeNativeStatus } from "../src/config.js";

const mocked = vi.hoisted(() => ({ evaluated: vi.fn(), read: vi.fn() }));
vi.mock("../src/native-status.js", () => {
  mocked.evaluated();
  return { readFsSafeNativeStatus: mocked.read };
});

it("defers status module evaluation until the async API is called", async () => {
  expect(mocked.evaluated).not.toHaveBeenCalled();
  const value = { reason: "not-probed" };
  mocked.read.mockReturnValue(value);
  const options = { probe: false };
  const pending = getFsSafeNativeStatus(options);
  expect(pending).toBeInstanceOf(Promise);
  expect(await pending).toBe(value);
  expect(mocked.evaluated).toHaveBeenCalledOnce();
  expect(mocked.read).toHaveBeenCalledExactlyOnceWith(options);
});
