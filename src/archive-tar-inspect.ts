import { withExtractionDeadline } from "./archive-deadline.js";
import { validateArchiveEntryPath } from "./archive-entry.js";
import { stageArchiveFileForExtraction } from "./archive-input.js";
import { resolveExtractLimits, resolveTarMeterLimits } from "./archive-limits.js";
import { throwMappedNativeArchiveError } from "./archive-native.js";
import type { ExtractArchiveOptions } from "./archive-options.js";
import { createArchiveEntryPlanner, type ArchivePlanEntry } from "./archive-plan.js";
import { resolveArchiveFilteredEntryPolicy } from "./archive-policy.js";
import { createTarEntryPlanner } from "./archive-tar.js";
import { inspectTar } from "./archive-tar-stream.js";
import type { AdmittedTarMember } from "./archive-tar-wasm.js";
import { getNativeBinding } from "./native.js";

export type InspectTarArchiveOptions = Pick<ExtractArchiveOptions,
  "archivePath" | "timeoutMs" | "limits" | "entryFilter" | "onFiltered">;
export type InspectedTarEntry = Readonly<Pick<ArchivePlanEntry, "path" | "kind" | "size">>;

/** Complete TAR/gzip admission and zero-strip extraction policy, without output writes. */
export async function inspectTarArchive(params: InspectTarArchiveOptions): Promise<readonly InspectedTarEntry[]> {
  const onFiltered = resolveArchiveFilteredEntryPolicy(params.onFiltered);
  const limits = resolveExtractLimits(params.limits);
  const tarLimits = resolveTarMeterLimits(limits);
  const native = getNativeBinding();
  return await withExtractionDeadline(params.timeoutMs, "inspect tar", async (deadline) => {
    const staged = await stageArchiveFileForExtraction({ archivePath: params.archivePath, limits, deadline });
    try {
      // Staging closes descriptors asynchronously; expiry there must not start a decoder.
      deadline.check();
      const entries: InspectedTarEntry[] = [];
      const append = (entry: ArchivePlanEntry | null) => {
        if (entry) entries.push(Object.freeze({ path: entry.path, kind: entry.kind, size: entry.size }));
      };
      const policy = { limits, entryFilter: params.entryFilter, onFiltered };
      if (native) {
        const manifest = await native.inspectArchiveNative(staged.path, "tar", tarLimits, deadline.signal)
          .catch(throwMappedNativeArchiveError);
        deadline.check();
        // Match extraction's whole-manifest validation before caller policy runs.
        for (const entry of manifest) validateArchiveEntryPath(entry.path);
        const planEntry = createArchiveEntryPlanner({ ...policy, kind: "tar" });
        for (const entry of manifest) {
          deadline.check();
          append(planEntry(entry));
        }
      } else {
        const manifest: AdmittedTarMember[] = [];
        await inspectTar({ archivePath: staged.path, limits: tarLimits, signal: deadline.signal,
          onMember: (entry) => { manifest.push(entry); } });
        const planEntry = createTarEntryPlanner(policy);
        for (const entry of manifest) {
          deadline.check();
          append(planEntry(entry));
        }
      }
      deadline.check();
      // This is bounded evidence about the staged bytes, not a reusable write plan.
      return Object.freeze(entries);
    } finally {
      await staged.cleanup();
    }
  });
}
