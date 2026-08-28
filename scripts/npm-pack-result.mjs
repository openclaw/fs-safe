/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} packageName
 * @returns {{ filename: string; files: Array<{ path: string }> }}
 */
export function normalizePackResult(value, packageName) {
  let entry;
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error(`npm pack result must contain exactly one package: ${packageName}`);
    }
    entry = value[0];
  } else if (isRecord(value)) {
    if (Object.keys(value).length !== 1 || !Object.hasOwn(value, packageName)) {
      throw new Error(`npm pack result must contain only the package key: ${packageName}`);
    }
    entry = value[packageName];
  } else {
    throw new Error("npm pack result must be an array or a package-name-keyed object");
  }

  if (!isRecord(entry) || entry.name !== packageName) {
    throw new Error(`npm pack result must describe package: ${packageName}`);
  }
  const { filename, files } = entry;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error(`npm pack result for ${packageName} must have a non-empty filename`);
  }
  if (
    !Array.isArray(files) ||
    !files.every((file) => isRecord(file) && typeof file.path === "string" && file.path.length > 0)
  ) {
    throw new Error(`npm pack result for ${packageName} must have a files array of non-empty paths`);
  }
  return { filename, files };
}
