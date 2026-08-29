import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

// Test-owned, finite registry: no proxying, writes, credentials, or public listener.
export async function startConsumerRegistry(artifacts) {
  const packages = new Map();
  const tarballs = new Map();
  const requests = [];
  for (const { pkg, tarball, integrity } of artifacts) {
    const bytes = readFileSync(tarball);
    const observed = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity) assert.equal(observed, integrity, `artifact integrity: ${pkg.name}`);
    const route = `/tarballs/${tarballs.size}.tgz`;
    tarballs.set(route, bytes);
    const versions = packages.get(pkg.name) ?? {};
    assert.ok(!versions[pkg.version], `duplicate fixture ${pkg.name}@${pkg.version}`);
    versions[pkg.version] = { ...pkg, dist: { integrity: observed, tarball: route } };
    packages.set(pkg.name, versions);
  }
  let registry;
  const server = createServer((request, response) => {
    const route = request.url;
    requests.push({ method: request.method, path: route });
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (tarballs.has(route)) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarballs.get(route));
      return;
    }
    let name;
    try {
      name = decodeURIComponent(route.slice(1));
    } catch {
      response.writeHead(400).end();
      return;
    }
    const versions = packages.get(name);
    if (!versions) {
      response.writeHead(404).end(JSON.stringify({ error: "not in fixture" }));
      return;
    }
    const resolved = Object.fromEntries(Object.entries(versions).map(([version, pkg]) => [
      version, { ...pkg, dist: { ...pkg.dist, tarball: registry + pkg.dist.tarball } },
    ]));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      name, "dist-tags": { latest: Object.keys(versions).at(-1) }, versions: resolved,
      // Fixture versions are intentionally old enough for pnpm's age policy.
      time: Object.fromEntries(Object.keys(versions).map((version) => [version, "2020-01-01T00:00:00.000Z"])),
    }));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  registry = `http://127.0.0.1:${server.address().port}`;
  return {
    registry, requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
