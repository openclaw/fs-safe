import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import {
  replaceFileAtomic,
  replaceFileAtomicSync,
  writeTextAtomic,
} from "../src/atomic.js";
import { writeJson, writeJsonSync } from "../src/json.js";
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
      import { replaceFileAtomic, replaceFileAtomicSync, writeTextAtomic } from ${JSON.stringify(new URL("../dist/atomic.js", import.meta.url).href)};
      import { writeJson, writeJsonSync } from ${JSON.stringify(new URL("../dist/json.js", import.meta.url).href)};
      const kind = ${JSON.stringify(kind)};
      const prefixes = ['.', '..', 'child' + path.sep + '..'];
      const drive = process.platform === 'win32'
        ? path.parse(process.cwd()).root.slice(0, 2)
        : undefined;
      if (drive) prefixes.push(drive + '.');
      const publish = async (filePath, value, atomicOptions = {}) => {
        if (kind === 'atomic') {
          await replaceFileAtomic({
            filePath,
            content: JSON.stringify(value),
            ...atomicOptions,
          });
        } else if (kind === 'atomic-sync') {
          replaceFileAtomicSync({
            filePath,
            content: JSON.stringify(value),
            ...atomicOptions,
          });
        } else if (kind === 'json') await writeJson(filePath, value);
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

      let driveRelativeExtras = 0;
      let lockedDriveRelative = false;
      let callbackPathAnchored = false;
      if (drive) {
        for (const suffix of [
          kind + '-bare.json',
          'child' + path.sep + '..' + path.sep + kind + '-nested.json',
        ]) {
          const filePath = drive + suffix;
          const value = { kind, suffix };
          await publish(filePath, value);
          assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), value);
          driveRelativeExtras++;
        }

        if (kind === 'atomic' || kind === 'atomic-sync') {
          const filePath = drive + kind + '-locked.json';
          let callbackPath;
          await publish(filePath, { kind, locked: true }, {
            renameIdentity: 'verify-content-with-lock',
            beforeRename: (params) => { callbackPath = params.filePath; },
          });
          assert.equal(path.isAbsolute(callbackPath), true);
          assert.equal(callbackPath.endsWith(kind + '-locked.json'), true);
          assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {
            kind,
            locked: true,
          });
          assert.deepEqual(
            fs.readdirSync(path.dirname(path.resolve(filePath)))
              .filter((name) => name.startsWith('.fs-safe-atomic-') && name.endsWith('.lock')),
            [],
          );
          lockedDriveRelative = true;
          callbackPathAnchored = true;
        }
      }

      console.log(JSON.stringify({
        operations,
        driveRelativeExtras,
        lockedDriveRelative,
        callbackPathAnchored,
        bun: Boolean(process.versions.bun),
      }));
    `], { cwd: working, timeout: 10_000 });
    const windows = process.platform === "win32";
    const atomic = kind === "atomic" || kind === "atomic-sync";
    expect(JSON.parse(stdout)).toEqual({
      operations: windows ? 4 : 3,
      driveRelativeExtras: windows ? 2 : 0,
      lockedDriveRelative: windows && atomic,
      callbackPathAnchored: windows && atomic,
      bun: Boolean(process.versions.bun),
    });
  },
);

it.runIf(process.platform === "win32")(
  "captures drive-relative text and JSON paths before caller-controlled callbacks",
  async () => {
    const sandbox = await tempRoot("fs-safe-drive-callback-capture-");
    const working = path.join(sandbox, "working");
    const detour = path.join(working, "detour");
    await fs.mkdir(detour, { recursive: true });
    const { stdout } = await exec(process.execPath, ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { writeTextAtomic } from ${JSON.stringify(new URL("../dist/atomic.js", import.meta.url).href)};
      import { writeJson } from ${JSON.stringify(new URL("../dist/json.js", import.meta.url).href)};
      const working = process.cwd();
      const detour = path.join(working, 'detour');
      const drive = path.parse(working).root.slice(0, 2);
      let optionReads = 0;
      await writeTextAtomic(drive + 'captured-text.txt', 'text', {
        get trailingNewline() {
          optionReads++;
          process.chdir(detour);
          return false;
        },
        durable: false,
      });
      process.chdir(working);
      let serializations = 0;
      await writeJson(drive + 'captured-json.json', {
        toJSON() {
          serializations++;
          process.chdir(detour);
          return { captured: true };
        },
      }, { durable: false });
      process.chdir(working);
      assert.equal(fs.readFileSync(path.join(working, 'captured-text.txt'), 'utf8'), 'text');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(working, 'captured-json.json'), 'utf8')),
        { captured: true },
      );
      assert.deepEqual(fs.readdirSync(detour), []);
      console.log(JSON.stringify({ optionReads, serializations }));
    `], { cwd: working, timeout: 10_000 });

    expect(JSON.parse(stdout)).toEqual({ optionReads: 1, serializations: 1 });
  },
);

it.runIf(process.platform === "win32")(
  "rejects drive-relative namespace aliases before standalone publication authority",
  async () => {
    const drive = path.parse(process.cwd()).root.slice(0, 2);
    const aliases = [
      `${drive}state.json:payload`,
      `${drive}child:stream${path.sep}..${path.sep}state.json`,
      `nested${path.sep}${drive}state.json`,
      `${path.sep}${path.sep}?${path.sep}${drive}`,
      `${drive}${path.sep}state.json:payload`,
    ];

    for (const filePath of aliases) {
      let asyncAuthorityReads = 0;
      await expect(replaceFileAtomic({
        filePath,
        content: "bad",
        get fileSystem() {
          asyncAuthorityReads += 1;
          throw new Error("filesystem authority must not be read");
        },
      })).rejects.toMatchObject({
        code: "invalid-path",
        details: { reason: "windows-path-alias" },
      });
      expect(asyncAuthorityReads).toBe(0);

      let syncAuthorityReads = 0;
      expect(() => replaceFileAtomicSync({
        filePath,
        content: "bad",
        get fileSystem() {
          syncAuthorityReads += 1;
          throw new Error("filesystem authority must not be read");
        },
      })).toThrow(expect.objectContaining({
        code: "invalid-path",
        details: { reason: "windows-path-alias" },
      }));
      expect(syncAuthorityReads).toBe(0);

      const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValue(
        new Error("filesystem authority must not run"),
      );
      const mkdirSync = vi.spyOn(fsSync, "mkdirSync").mockImplementation(() => {
        throw new Error("filesystem authority must not run");
      });
      try {
        let textOptionReads = 0;
        await expect(writeTextAtomic(filePath, "bad", {
          get durable() {
            textOptionReads += 1;
            throw new Error("text options must not be read");
          },
        })).rejects.toMatchObject({
          code: "invalid-path",
        });
        expect(textOptionReads).toBe(0);
        let jsonSerializationCalls = 0;
        let jsonOptionReads = 0;
        await expect(writeJson(filePath, {
          toJSON() {
            jsonSerializationCalls += 1;
            throw new Error("JSON value must not be serialized");
          },
        }, {
          get durable() {
            jsonOptionReads += 1;
            throw new Error("JSON options must not be read");
          },
        })).rejects.toMatchObject({
          code: "invalid-path",
        });
        expect(jsonSerializationCalls).toBe(0);
        expect(jsonOptionReads).toBe(0);
        expect(() => writeJsonSync(filePath, { bad: true })).toThrow(
          expect.objectContaining({ code: "invalid-path" }),
        );
        expect(mkdir).not.toHaveBeenCalled();
        expect(mkdirSync).not.toHaveBeenCalled();
      } finally {
        mkdir.mockRestore();
        mkdirSync.mockRestore();
      }
    }
  },
);
