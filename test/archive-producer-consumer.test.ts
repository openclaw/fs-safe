import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveArchiveProducerConsumer } from "../scripts/archive-producer-consumer.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
async function consumerFixture(pnpm = false) {
  const consumer = await tempRoot("fs-safe-archive-consumer-");
  await fs.writeFile(path.join(consumer, "package.json"), '{"private":true}');
  const visible = path.join(consumer, "node_modules", "@openclaw", "fs-safe");
  const installed = pnpm
    ? path.join(consumer, "node_modules", ".pnpm", "fs-safe-fixture", "node_modules", "@openclaw", "fs-safe")
    : visible;
  await fs.mkdir(path.join(installed, "dist"), { recursive: true });
  await fs.writeFile(path.join(installed, "package.json"), JSON.stringify({
    name: "@openclaw/fs-safe", type: "module",
    exports: { "./package.json": "./package.json", "./config": "./dist/config.js", "./archive": "./dist/archive.js" },
  }));
  for (const name of ["config", "archive"]) {
    await fs.writeFile(path.join(installed, "dist", `${name}.js`), 'throw new Error("package code must not run during admission");');
  }
  if (pnpm) {
    await fs.mkdir(path.dirname(visible), { recursive: true });
    await fs.symlink(installed, visible, "junction");
  }
  return { consumer, installed };
}

it.each([false, true])("admits consumer-local installed entries with pnpm layout=%s", async pnpm => {
  const { consumer, installed } = await consumerFixture(pnpm);
  expect(resolveArchiveProducerConsumer(consumer)).toEqual({
    manifest: path.join(installed, "package.json"), packageDir: installed,
    configEntry: path.join(installed, "dist", "config.js"),
    archiveEntry: path.join(installed, "dist", "archive.js"),
  });
});

it("rejects the workspace before package self-resolution", () => {
  expect(() => resolveArchiveProducerConsumer(fileURLToPath(new URL("..", import.meta.url))))
    .toThrow("requires a separate installed consumer");
});

it("rejects a nested directory whose package resolves upward", async () => {
  const { consumer } = await consumerFixture();
  const nested = path.join(consumer, "nested");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "package.json"), '{"private":true}');
  expect(() => resolveArchiveProducerConsumer(nested))
    .toThrow("package must resolve inside the consumer's node_modules");
});

it("rejects a linked package outside the consumer", async () => {
  const { installed } = await consumerFixture();
  const consumer = await tempRoot("fs-safe-archive-linked-consumer-");
  const visible = path.join(consumer, "node_modules", "@openclaw", "fs-safe");
  await fs.mkdir(path.dirname(visible), { recursive: true });
  await fs.symlink(installed, visible, "junction");
  expect(() => resolveArchiveProducerConsumer(consumer))
    .toThrow("package must resolve inside the consumer's node_modules");
});

it("rejects installed entry links that escape the admitted package", async () => {
  const { consumer, installed } = await consumerFixture();
  const displaced = path.join(consumer, "outside-package");
  await fs.rename(path.join(installed, "dist"), displaced);
  await fs.symlink(displaced, path.join(installed, "dist"), "junction");
  expect(() => resolveArchiveProducerConsumer(consumer))
    .toThrow("entry must resolve inside the installed package");
});
