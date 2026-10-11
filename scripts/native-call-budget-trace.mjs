// Node/V8's Abseil lazily probes the TSC frequency, including on the main
// thread. This exact read-only sysfs open is unrelated to the fixture tree.
// Keep every other open (and any subsequent I/O) in the strict budget.
export function isRuntimeClockProbe(line) {
  return /^\d+\s+openat\(AT_FDCWD(?:<[^>\n]*>)?, "\/sys\/devices\/system\/cpu\/cpu0\/tsc_freq_khz", O_RDONLY\|O_CLOEXEC(?:\)| <unfinished \.\.\.>$)/.test(line);
}
