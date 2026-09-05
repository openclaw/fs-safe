import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { stripArchivePath } from "./archive-entry.js";
import { type ExtractionDeadline } from "./archive-deadline.js";
import type { ResolvedArchiveExtractLimits, TarMeterLimits } from "./archive-limits.js";
import { mergePlannedArchiveIntoDestination } from "./archive-merge.js";
import type { ExtractArchiveOptions } from "./archive-options.js";
import { resolveArchiveEntryMode } from "./archive-policy.js";
import { prepareArchiveDestinationDir, preparePrivateArchiveOutputPath, withStagedArchiveDestination } from "./archive-staging.js";
import { createTarEntryPreflightChecker } from "./archive-tar.js";
import { inspectTar, replayTar } from "./archive-tar-stream.js";
import type { AdmittedTarMember } from "./archive-tar-wasm.js";
import { runPinnedWriteHelper } from "./pinned-write.js";

export async function extractWasmTar(params: {
  archivePath: string; options: ExtractArchiveOptions; limits: ResolvedArchiveExtractLimits;
  tarLimits: TarMeterLimits; deadline: ExtractionDeadline;
}): Promise<void> {
  const { options, deadline, tarLimits } = params;
  const manifest: AdmittedTarMember[] = [];
  await inspectTar({ archivePath: params.archivePath, limits: tarLimits, signal: deadline.signal,
    onMember: (entry) => { manifest.push(entry); } });
  deadline.check();
  const destinationRealDir = await prepareArchiveDestinationDir(options.destDir);
  await withStagedArchiveDestination({ destinationRealDir, run: async (stagingPath) => {
    const stagingDir = await fs.realpath(stagingPath);
    const check = createTarEntryPreflightChecker({ rootDir: destinationRealDir,
      stripComponents: options.stripComponents, limits: params.limits,
      entryFilter: options.entryFilter, onFiltered: options.onFiltered });
    const strip = Math.max(0, Math.floor(options.stripComponents ?? 0));
    const accepted = manifest.filter((entry) => { deadline.check(); return check(entry); }).map((entry) => {
      const kind = entry.type === "Directory" || entry.type === "GNUDumpDir" ? "directory" as const : "file" as const;
      return { ...entry, path: stripArchivePath(entry.path, strip)!, kind,
        mode: resolveArchiveEntryMode({ kind, archivedMode: entry.mode, policy: options.entryModes }) };
    });
    await replayTar({ archivePath: params.archivePath, limits: tarLimits, signal: deadline.signal, members: accepted,
      async consume(member, payload) {
        deadline.check();
        await preparePrivateArchiveOutputPath({ destinationDir: stagingDir, destinationRealDir: stagingDir,
          relPath: member.path, outPath: path.join(stagingDir, member.path), originalPath: member.path,
          isDirectory: member.kind === "directory", deadline });
        if (member.kind === "file") {
          await runPinnedWriteHelper({ rootPath: stagingDir, relativeParentPath: path.posix.dirname(member.path),
            basename: path.posix.basename(member.path), mkdir: false, mode: 0o600, overwrite: false,
            maxBytes: member.size, input: { kind: "stream", stream: Readable.from(payload) } });
        }
        deadline.check();
      },
    });
    deadline.check();
    await mergePlannedArchiveIntoDestination({ entries: accepted, sourceDir: stagingDir,
      destinationDir: options.destDir, destinationRealDir, deadline });
    deadline.check();
  } });
}
