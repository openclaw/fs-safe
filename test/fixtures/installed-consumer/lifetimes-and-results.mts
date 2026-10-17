import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { Root } from "@openclaw/fs-safe/root";
import { tempWorkspace, tempWorkspaceSync } from "@openclaw/fs-safe/temp";
import type { RetainedFileAdmission, RootFileOpenResult } from "@openclaw/fs-safe/advanced";
import type { ExactFileIdentity } from "@openclaw/fs-safe/types";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

export async function resources(scoped: Root, rootDir: string) {
  await using temporary = await tempWorkspace({ rootDir, prefix: "consumer-" });
  using synchronous = tempWorkspaceSync({ rootDir, prefix: "consumer-" });
  await using opened = await scoped.open("file");
  const written = temporary.writeText("file", "value");
  const writtenSync = synchronous.writeText("file", "value");
  type Written = Expect<Equal<typeof written, Promise<string>>>;
  type WrittenSync = Expect<Equal<typeof writtenSync, string>>;
  type Identity = Expect<Equal<typeof temporary.exactIdentity, ExactFileIdentity>>;
  type SyncIdentity = Expect<Equal<typeof synchronous.exactIdentity, ExactFileIdentity>>;
  type Handle = Expect<Equal<typeof opened.handle, FileHandle>>;
  type Metadata = Expect<Equal<typeof opened.stat, Stats>>;
  type OpenIdentity = Expect<Equal<typeof opened.exactIdentity, ExactFileIdentity>>;
  // @ts-expect-error async resources cannot be disposed synchronously
  using wrong = await tempWorkspace({ rootDir, prefix: "consumer-" });
  // @ts-expect-error exact identity cannot be rounded to a number
  const rounded: number = opened.exactIdentity.ino;
  // @ts-expect-error producer observations are immutable
  opened.exactIdentity.dev = 1n;
}

export function results(opened: RootFileOpenResult, admission: RetainedFileAdmission) {
  if (opened.ok) {
    const descriptor: number = opened.fd;
    const identity: ExactFileIdentity = opened.exactIdentity;
  } else {
    // @ts-expect-error a failed open carries no descriptor capability
    opened.fd;
  }
  if (admission.status === "retained") {
    using retained = admission.file;
    retained.dispose();
  } else {
    // @ts-expect-error only retained admission carries a file capability
    admission.file;
  }
}
