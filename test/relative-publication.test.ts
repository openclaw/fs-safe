import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const exec = promisify(execFile);

it.each(["atomic", "atomic-sync", "json", "json-sync"])(
  "publishes %s files through existing relative dot directories",
  async (kind) => {
    const sandbox = await tempRoot("fs-safe-relative-publication-");
    const working = path.join(sandbox, "working");
    await fs.mkdir(path.join(working, "child"), { recursive: true });
    const { stdout } = await exec(process.execPath, ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { replaceFileAtomic, replaceFileAtomicSync } from ${JSON.stringify(new URL("../dist/atomic.js", import.meta.url).href)};
      import { writeJson, writeJsonSync } from ${JSON.stringify(new URL("../dist/json.js", import.meta.url).href)};
      const kind = ${JSON.stringify(kind)};
      const prefixes = ['.', '..', 'child' + path.sep + '..'];
      const publish = async (filePath, value) => {
        if (kind === 'atomic') await replaceFileAtomic({ filePath, content: JSON.stringify(value) });
        else if (kind === 'atomic-sync') replaceFileAtomicSync({ filePath, content: JSON.stringify(value) });
        else if (kind === 'json') await writeJson(filePath, value);
        else writeJsonSync(filePath, value);
      };
      let operations = 0;
      for (const prefix of prefixes) {
        const filePath = prefix + path.sep + kind + '-' + operations + '.json';
        const value = { kind, prefix };
        await publish(filePath, value);
        assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), value);
        operations++;
      }
      let rejectedDriveRelative = false;
      if (process.platform === 'win32') {
        const prefix = path.parse(process.cwd()).root.slice(0, 2) + '.';
        const filePath = prefix + path.sep + kind + '-rejected.json';
        await assert.rejects(
          publish(filePath, { kind, prefix }),
          (error) => error?.code === 'invalid-path' &&
            error?.details?.reason === 'windows-path-alias',
        );
        assert.equal(fs.existsSync(filePath), false);
        rejectedDriveRelative = true;
      }
      console.log(JSON.stringify({
        operations,
        rejectedDriveRelative,
        bun: Boolean(process.versions.bun),
      }));
    `], { cwd: working, timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({
      operations: 3,
      rejectedDriveRelative: process.platform === "win32",
      bun: Boolean(process.versions.bun),
    });
  },
);
