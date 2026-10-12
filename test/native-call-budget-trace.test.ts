import { expect, it } from "vitest";
import { canonicalizeBudgetSyscalls, isRuntimeClockProbe } from "../scripts/native-call-budget-trace.mjs";

it("stores ARM64 syscall aliases in the shared fixture spelling", () => {
  expect(canonicalizeBudgetSyscalls({ readlinkat: 4, mkdirat: 1, openat: 2 }, "arm64"))
    .toEqual({ readlink: 4, mkdir: 1, openat: 2 });
  expect(canonicalizeBudgetSyscalls({ readlink: 1, readlinkat: 2 }, "arm64"))
    .toEqual({ readlink: 3 });
  expect(canonicalizeBudgetSyscalls({ readlinkat: 4, mkdirat: 1 }, "x64"))
    .toEqual({ readlinkat: 4, mkdirat: 1 });
});

const probe = '14009 openat(AT_FDCWD</work/fixture>, "/sys/devices/system/cpu/cpu0/tsc_freq_khz", O_RDONLY|O_CLOEXEC)';

it("excludes the runtime TSC probe on any thread, including unfinished calls", () => {
  expect(isRuntimeClockProbe(`${probe} = -1 ENOENT (No such file or directory)`)).toBe(true);
  expect(isRuntimeClockProbe(`${probe.replace("14009", "14010").slice(0, -1)} <unfinished ...>`)).toBe(true);
  expect(isRuntimeClockProbe(`${probe.replace("</work/fixture>", "")} = -1 ENOENT (No such file or directory)`)).toBe(true);
});

it.each([
  probe.replace("/sys/devices/system/cpu/cpu0/tsc_freq_khz", "/tmp/fs-safe-native-budget-example/child"),
  probe.replace("/sys/devices/system/cpu/cpu0/tsc_freq_khz", "/tmp"),
  probe.replace("/sys/devices/system/cpu/cpu0/tsc_freq_khz", "/proc/self/fd/21"),
  probe.replace("/sys/devices/system/cpu/cpu0/tsc_freq_khz", "/sys/devices/system/cpu/cpu0/tsc_freq_khz-other"),
  probe.replace("O_RDONLY|O_CLOEXEC", "O_WRONLY|O_CLOEXEC"),
  probe.replace("O_RDONLY|O_CLOEXEC", "O_RDONLY|O_CLOEXEC|O_PATH"),
  probe.replace('AT_FDCWD</work/fixture>, "/sys/devices/system/cpu/cpu0/tsc_freq_khz"', '21</tmp/fs-safe-native-budget-example>, "child"'),
  '14010 fstat(21</tmp/fs-safe-native-budget-example/child>, {st_mode=S_IFREG|0600}) = 0',
  '14010 read(21</sys/devices/system/cpu/cpu0/tsc_freq_khz>, "1000", 4) = 4',
  '14010 close(21</sys/devices/system/cpu/cpu0/tsc_freq_khz>) = 0',
])("keeps filesystem work and unknown calls in the budget: %s", (line) => {
  expect(isRuntimeClockProbe(line)).toBe(false);
});
