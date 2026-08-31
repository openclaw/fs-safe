// Full behavioral cases run on JS/plain TAR and real native/zstd. The other
// eight routes run representative cases from every behavior category; this is
// deliberately not a type × behavior × codec cross-product. Raw meter tests
// separately prove all 256 parser classifications and all 240 hidden bytes.
export const tarAdmissionRoutes = [
  { mode: "off", format: "tar", full: true },
  { mode: "off", format: "gzip", full: false },
  { mode: "auto", format: "tar", full: false },
  { mode: "auto", format: "gzip", full: false },
  { mode: "auto", format: "tar-zstd", full: false },
  { mode: "auto", format: "tar-bzip2", full: false },
  { mode: "require", format: "tar", full: false },
  { mode: "require", format: "gzip", full: false },
  { mode: "require", format: "tar-zstd", full: true },
  { mode: "require", format: "tar-bzip2", full: false },
] as const;
