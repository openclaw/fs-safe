const [platform, arch, minimum] = process.argv.slice(2);
const actual = process.versions.node;
const required = /^(\d+)\.(\d+)\.(\d+)$/.exec(minimum ?? "");
const installed = /^(\d+)\.(\d+)\.(\d+)$/.exec(actual);
const supportedVersion = required && installed
  && installed[1] === required[1]
  && (Number(installed[2]) > Number(required[2])
    || (Number(installed[2]) === Number(required[2]) && Number(installed[3]) >= Number(required[3])));

// FreeBSD's pkg selects a major line; the actual executable still needs admission.
if (process.platform !== platform || process.arch !== arch || !supportedVersion) {
  console.error(`CI runtime rejected: ${process.execPath} is Node ${actual} (${process.platform}/${process.arch}); expected ${platform}/${arch} and stable Node >=${minimum} within that major. Refresh pkg metadata, pkg upgrade the selected Node package, and rerun; do not continue native proof with this runtime.`);
  process.exit(1);
}
console.log(`CI runtime admitted: ${process.execPath} is Node ${actual} (${process.platform}/${process.arch}); patched floor ${minimum}.`);
