//! Synthetic OCM-style directory-link TAR, written to stdout without extraction.
use std::io::{self, Write};

fn main() -> io::Result<()> {
    let mut builder = tar::Builder::new(Vec::new());
    builder.append_pax_extensions([("LIBARCHIVE.symlinktype", &b"dir"[..])])?;
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_mode(0o644);
    header.set_size(0);
    builder.append_link(&mut header, "link", "target")?;
    io::stdout().lock().write_all(&builder.into_inner()?)
}
