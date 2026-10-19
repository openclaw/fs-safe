import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { list } from "tar";
import { parse } from "acorn";

function isImportMetaUrl(node) {
  return node?.type === "MemberExpression" && !node.computed && node.property.name === "url"
    && node.object.type === "MetaProperty" && node.object.meta.name === "import"
    && node.object.property.name === "meta";
}

function runtimeReference(node) {
  if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]
    .includes(node.type)) return { source: node.source, url: true };
  if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
    return { source: node.arguments[0], url: false };
  }
  if (node.type === "NewExpression" && node.callee.type === "Identifier") {
    if (node.callee.name === "URL" && node.arguments[1]
      && isImportMetaUrl(node.arguments[1])) return { source: node.arguments[0], url: true };
  }
}

function literalString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
}

/** Check the bytes in the archive, never a possibly more complete source tree. */
export async function assertPackedRuntimeFiles(archive) {
  const paths = new Set();
  const sources = new Map();
  await list({ file: archive, onReadEntry(entry) {
    if (entry.type !== "File") return;
    const path = entry.path.replace(/^package\//u, "");
    paths.add(path);
    if (!/^dist\/.*\.(?:[cm]?js)$/u.test(path)) return;
    const chunks = [];
    entry.on("data", chunk => chunks.push(chunk));
    entry.on("end", () => sources.set(path, Buffer.concat(chunks).toString("utf8")));
  } });

  const missing = new Set();
  let references = 0;
  for (const [path, text] of sources) {
    const source = parse(text, { ecmaVersion: "latest", sourceType: path.endsWith(".cjs") ? "script" : "module" });
    const moduleUrl = new URL(path.split("/").map(encodeURIComponent).join("/"), "file:///__package__/");
    function visit(node) {
      const reference = runtimeReference(node);
      const specifier = literalString(reference?.source);
      if (specifier && /^\.\.?\//u.test(specifier)) {
        references++;
        // URL references decode filenames and discard queries/fragments; require paths are literal.
        const target = reference.url
          ? posix.relative("/__package__", fileURLToPath(new URL(specifier, moduleUrl), { windows: false }))
          : posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!paths.has(target)) missing.add(`${path}: ${specifier} -> ${target}`);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) if (child?.type) visit(child);
        } else if (value?.type) visit(value);
      }
    }
    visit(source);
  }
  if (sources.size === 0) throw new Error("packed package contains no dist JavaScript files");
  if (missing.size) {
    throw new Error(`packed package is missing relative runtime files:\n${[...missing].sort().join("\n")}`);
  }
  return { modules: sources.size, references };
}
