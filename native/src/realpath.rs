use napi_derive::napi;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn canonicalize_ordinary(path: &str) -> std::io::Result<PathBuf> {
    let input = Path::new(path);
    let mut path = normalize(&if input.is_absolute() {
        input.to_owned()
    } else {
        std::env::current_dir()?.join(input)
    });
    let mut known_hard = HashSet::new();
    // Ordinary resolution can traverse more links than one kernel realpath
    // call. Bound total expansions independently of the unresolved suffix: a
    // lexical cycle can grow that suffix while its physical target stays valid.
    let mut remaining_links = 1024;
    loop {
        let mut prefix = PathBuf::new();
        let mut components = path.components();
        let mut expanded = None;
        while let Some(component) = components.next() {
            prefix.push(component.as_os_str());
            if component == Component::RootDir || known_hard.contains(&prefix) {
                continue;
            }
            let metadata = std::fs::symlink_metadata(&prefix)?;
            if !metadata.is_symlink() {
                known_hard.insert(prefix.clone());
                continue;
            }
            if remaining_links == 0 {
                return Err(std::io::Error::from_raw_os_error(
                    rustix::io::Errno::LOOP.raw_os_error(),
                ));
            }
            remaining_links -= 1;
            // Node's ordinary resolver stats the referent before reading the
            // link, rejecting dangling links and kernel-detected cycles. It then
            // normalizes EACH expanded target lexically before restarting. Using
            // libc realpath here would instead follow a link before its '..'.
            std::fs::metadata(&prefix)?;
            let target = std::fs::read_link(&prefix)?;
            prefix.pop();
            let mut resolved = normalize(&prefix.join(target));
            if !components.as_path().as_os_str().is_empty() {
                resolved.push(components.as_path());
            }
            expanded = Some(resolved);
            break;
        }
        match expanded {
            Some(next) => path = next,
            None => return Ok(path),
        }
    }
}

#[napi(object)]
pub struct NativeRealpathResult {
    pub path: Option<String>,
    pub errno: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustix::fs::{FlockOperation, fcntl_lock};
    use std::{env, fs, process::Command, time::SystemTime};

    #[test]
    fn ordinary_resolution_rejects_lexical_symlink_cycles() {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!(
            "fs-safe-realpath-cycle-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(directory.join("target/child")).unwrap();
        std::os::unix::fs::symlink("target/child", directory.join("b")).unwrap();
        for (name, target) in [("a", "b/../a"), ("growing", "b/../growing/child")] {
            fs::create_dir_all(directory.join("target").join(name).join("child")).unwrap();
            std::os::unix::fs::symlink(target, directory.join(name)).unwrap();
            assert!(fs::canonicalize(directory.join(name)).is_ok());
            assert_eq!(
                canonicalize_ordinary(directory.join(name).to_str().unwrap())
                    .unwrap_err()
                    .raw_os_error(),
                Some(rustix::io::Errno::LOOP.raw_os_error())
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn canonicalization_preserves_record_locks() {
        const TEST: &str = "realpath::tests::canonicalization_preserves_record_locks";
        const FILE: &str = "FS_SAFE_REALPATH_LOCK_TEST_FILE";
        const EXPECTED: &str = "FS_SAFE_REALPATH_LOCK_TEST_BLOCKED";
        if let Some(path) = env::var_os(FILE) {
            let file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .unwrap();
            let result = fcntl_lock(&file, FlockOperation::NonBlockingLockExclusive);
            if env::var(EXPECTED).unwrap() == "yes" {
                assert!(matches!(
                    result,
                    Err(rustix::io::Errno::AGAIN | rustix::io::Errno::ACCESS)
                ));
            } else {
                result.unwrap();
            }
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "fs-safe-realpath-lock-{}-{nonce}",
            std::process::id()
        ));
        let file = fs::File::create_new(&path).unwrap();
        fcntl_lock(&file, FlockOperation::NonBlockingLockExclusive).unwrap();
        let check = |blocked| {
            let output = Command::new(env::current_exe().unwrap())
                .args(["--exact", TEST])
                .env(FILE, &path)
                .env(EXPECTED, if blocked { "yes" } else { "no" })
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
        };
        check(true);
        for _ in 0..500 {
            for ordinary in [false, true] {
                assert!(
                    canonicalize_path(path.to_str().unwrap().to_owned(), ordinary)
                        .path
                        .is_some()
                );
            }
        }
        check(true);
        // Positive control: even closing a second descriptor releases POSIX locks.
        // A future resolver that opens/closes the leaf fails the preceding check.
        drop(fs::File::open(&path).unwrap());
        check(false);
        drop(file);
        fs::remove_file(path).unwrap();
    }
}

#[napi(js_name = "canonicalizePath")]
pub fn canonicalize_path(path: String, ordinary: bool) -> NativeRealpathResult {
    // Unix std::fs::canonicalize calls libc realpath (DARWIN_EXTSN on macOS),
    // captures errno immediately and frees the allocated result. It does not
    // open/close the leaf, which would require read access, reject sockets or
    // release this process's POSIX record locks. Preserve raw symlink/.. order;
    // the TypeScript owner selects Node's ordinary versus native semantics.
    let result = if ordinary {
        canonicalize_ordinary(&path)
    } else {
        std::fs::canonicalize(path)
    };
    match result {
        Ok(path) => NativeRealpathResult {
            path: Some(path.to_string_lossy().into_owned()),
            errno: None,
        },
        Err(error) => NativeRealpathResult {
            path: None,
            errno: Some(
                error
                    .raw_os_error()
                    .unwrap_or(rustix::io::Errno::INVAL.raw_os_error()),
            ),
        },
    }
}
