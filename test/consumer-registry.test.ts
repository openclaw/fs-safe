import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startConsumerRegistry } from "../scripts/consumer-registry.mjs";
import { isolatedConsumerEnv } from "../scripts/consumer-install-smoke.mjs";

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "fs-safe-registry-test-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("consumer registry fixture", () => {
  it("serves exact foreign platform metadata and integrity-bound bytes without proxying", async () => {
    const bytes = Buffer.from("synthetic foreign payload");
    const tarball = join(temporary(), "fixture.tgz");
    writeFileSync(tarball, bytes);
    const pkg = {
      name: "@openclaw/fs-safe-linux-arm64-musl", version: "0.6.0",
      os: ["linux"], cpu: ["arm64"], libc: ["musl"], main: "fs-safe-native.node",
    };
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const server = await startConsumerRegistry([{ pkg, tarball, integrity }]);
    expect(server.registry).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    try {
      const response = await fetch(`${server.registry}/@openclaw%2ffs-safe-linux-arm64-musl`);
      expect(response.status).toBe(200);
      const document = await response.json();
      const { dist, ...metadata } = document.versions[pkg.version];
      expect(metadata).toEqual(pkg);
      expect(dist.integrity).toBe(integrity);
      expect(dist.tarball.startsWith(`${server.registry}/tarballs/`)).toBe(true);
      expect(Buffer.from(await (await fetch(dist.tarball)).arrayBuffer())).toEqual(bytes);
      for (const route of ["/unknown", "/tarballs/99.tgz", "/%2e%2e%2fpackage.json", "/http://registry.npmjs.org/tar"]) {
        expect((await fetch(server.registry + route)).status).toBe(404);
      }
      expect((await fetch(server.registry + "/%broken")).status).toBe(400);
      expect((await fetch(server.registry + "/tar", { method: "PUT", body: "denied" })).status).toBe(405);
    } finally {
      await server.close();
    }
    await expect(fetch(server.registry)).rejects.toThrow();
  });

  it("refuses collected tarballs whose bytes no longer match their manifest", async () => {
    const tarball = join(temporary(), "tampered.tgz");
    writeFileSync(tarball, "changed");
    await expect(startConsumerRegistry([{
      pkg: { name: "@openclaw/fs-safe", version: "0.6.0" }, tarball,
      integrity: "sha512-does-not-match",
    }])).rejects.toThrow("artifact integrity");
  });

  it("does not inherit registry, auth, workspace, runtime injection, or proxy settings", () => {
    for (const name of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NODE_PATH", "NODE_OPTIONS", "npm_config_registry", "HTTPS_PROXY", "PNPM_HOME"]) {
      vi.stubEnv(name, "not-for-consumer");
    }
    const directory = temporary();
    const env = isolatedConsumerEnv(directory);
    for (const name of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NODE_PATH", "NODE_OPTIONS", "npm_config_registry", "HTTPS_PROXY", "PNPM_HOME"]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.HOME).toBe(directory);
    expect(env.npm_config_userconfig).toBe(join(directory, "userconfig.npmrc"));
    expect(env.npm_config_globalconfig).toBe(join(directory, "globalconfig.npmrc"));
    expect(env.npm_config_cache).toBe(join(directory, "npm-cache"));
  });
});
