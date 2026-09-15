import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DEPTHS = Object.freeze([1, 8, 32]);
const POLICIES = Object.freeze(["none", "enabled"]);
export const ROOT_WRITE_MUTATION_ADMISSION_NAMES = Object.freeze(
  DEPTHS.flatMap((depth) => [
    `Root.write/mutation-admission/existing/depth=${depth}`,
    `Root.write/mutation-admission/mkdir/depth=${depth}`,
  ]),
);

function descriptorName({ operation, mode, layout, policy, depth }) {
  const modeLabel = mode === undefined ? "" : `/mode=${mode}`;
  return `${operation}/shared-js-mutation-admission${modeLabel}/${layout}/policy=${policy}/depth=${depth}`;
}

export function sharedMutationAdmissionDescriptors(platform = process.platform) {
  const descriptors = [];
  const pair = (descriptor) => {
    for (const policy of POLICIES) {
      const complete = { ...descriptor, policy };
      descriptors.push(Object.freeze({ ...complete, name: descriptorName(complete) }));
    }
  };
  for (const depth of DEPTHS) {
    for (const mode of ["update", "append", "replace"]) {
      for (const layout of ["existing-target", "missing-parent"]) {
        pair({ operation: "Root.openWritable", mode, depth, layout });
      }
    }
    for (const layout of ["existing-target", "missing-parent"]) {
      pair({ operation: "Root.append", depth, layout });
    }
    for (const layout of ["existing-parent", "missing-parent"]) {
      pair({ operation: "Root.mkdir", depth, layout });
    }
  }
  if (platform === "win32") {
    const windowsOperations = [
      { operation: "Root.write", mode: "overwrite", existingLayout: "existing-target" },
      { operation: "Root.write", mode: "exclusive", existingLayout: "existing-parent" },
      { operation: "Root.create", mode: "exclusive", existingLayout: "existing-parent" },
    ];
    for (const depth of DEPTHS) {
      for (const { existingLayout, ...operation } of windowsOperations) {
        for (const layout of [existingLayout, "missing-parent"]) pair({ ...operation, depth, layout });
      }
    }
  }
  return Object.freeze(descriptors);
}

function runDescriptor(root, descriptor, relative, policyOptions) {
  const options = descriptor.policy === "enabled" ? policyOptions : {};
  if (descriptor.operation === "Root.openWritable") {
    return root.openWritable(relative, { ...options, writeMode: descriptor.mode });
  }
  if (descriptor.operation === "Root.append") {
    return root.append(relative, "payload", { ...options, durable: false });
  }
  if (descriptor.operation === "Root.mkdir") return root.mkdir(relative, options);
  if (descriptor.operation === "Root.write") {
    return root.write(relative, Buffer.from("payload"), {
      ...options,
      durable: false,
      overwrite: descriptor.mode === "overwrite",
      renameIdentity: "verify-content-with-lock",
    });
  }
  assert.equal(descriptor.operation, "Root.create");
  return root.create(relative, Buffer.from("payload"), {
    ...options,
    durable: false,
    renameIdentity: "verify-content-with-lock",
  });
}

function verifyDescriptor(descriptor, result, target) {
  if (descriptor.operation === "Root.openWritable") {
    assert(result?.handle);
    const expected = descriptor.layout === "existing-target" && descriptor.mode !== "replace"
      ? "original" : "";
    assert.equal(fs.readFileSync(target, "utf8"), expected);
  } else if (descriptor.operation === "Root.append") {
    const expected = descriptor.layout === "existing-target" ? "originalpayload" : "payload";
    assert.equal(fs.readFileSync(target, "utf8"), expected);
  } else if (descriptor.operation === "Root.mkdir") {
    assert(fs.statSync(target).isDirectory());
  } else {
    assert.equal(fs.readFileSync(target, "utf8"), "payload");
  }
}

export function registerSharedMutationAdmission({ root, workspace, register, platform = process.platform }) {
  const denied = path.join(workspace, "mutation-admission-denied");
  fs.mkdirSync(denied);
  const policyOptions = {
    denyMutations: { prefixes: [denied] },
    mutationSymlinks: "reject",
  };
  sharedMutationAdmissionDescriptors(platform).forEach((descriptor, index) => {
    const fixtureRoot = path.join(workspace, `ma-${index}`);
    const parent = path.join(
      fixtureRoot,
      ...Array.from({ length: descriptor.depth - 1 }, (_, component) => `d${component + 1}`),
    );
    const target = path.join(parent, "value");
    const relative = path.relative(workspace, target);
    register(descriptor.name, () => runDescriptor(root, descriptor, relative, policyOptions), {
      divisor: 10,
      before: () => {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        if (descriptor.layout === "missing-parent") return;
        fs.mkdirSync(parent, { recursive: true });
        if (descriptor.layout === "existing-target") fs.writeFileSync(target, "original");
      },
      verify: (result) => verifyDescriptor(descriptor, result, target),
      after: async (result) => {
        try {
          await result?.handle?.close();
        } finally {
          fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }
      },
    });
  });
}

export function registerRootWriteMutationAdmission({ root, workspace, register }) {
  const denied = path.join(workspace, "mutation-admission-denied-root-write");
  fs.mkdirSync(denied);
  const options = {
    denyMutations: { prefixes: [denied] },
    mutationSymlinks: "reject",
    durable: false,
  };
  for (const [depthIndex, depth] of DEPTHS.entries()) {
    const components = Array.from({ length: depth - 1 }, (_, index) => `d${index}`);
    const existingParent = path.join(workspace, `mutation-admission-existing-${depth}`, ...components);
    const existingTarget = path.join(existingParent, "value");
    fs.mkdirSync(existingParent, { recursive: true });
    fs.writeFileSync(existingTarget, "original");
    register(ROOT_WRITE_MUTATION_ADMISSION_NAMES[depthIndex * 2], () =>
      root.write(path.relative(workspace, existingTarget), "replacement", options), {
      divisor: 10,
      verify: () => assert.equal(fs.readFileSync(existingTarget, "utf8"), "replacement"),
    });

    const missingRoot = path.join(workspace, `mutation-admission-missing-${depth}`);
    const missingTarget = path.join(missingRoot, ...components, "value");
    register(ROOT_WRITE_MUTATION_ADMISSION_NAMES[depthIndex * 2 + 1], () =>
      root.write(path.relative(workspace, missingTarget), "replacement", options), {
      divisor: 10,
      before: () => fs.rmSync(missingRoot, { recursive: true, force: true }),
      verify: () => assert.equal(fs.readFileSync(missingTarget, "utf8"), "replacement"),
      after: () => fs.rmSync(missingRoot, { recursive: true, force: true }),
    });
  }
}
