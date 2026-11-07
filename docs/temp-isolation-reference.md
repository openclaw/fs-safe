# Temp workspace isolation reference

This reference demonstrates one way to satisfy the lifetime isolation
precondition for `trustedWritableAncestors`. It qualifies only this configuration;
it does not establish that another deployment has equivalent isolation.

The trusted host runs as UID/GID 10001. Its private temp root is owned by that
identity at mode `0700`, beneath a root-owned volume directory at mode `2777`.
An untrusted process uses the same kernel UID/GID. A trusted root supervisor
places that process in separate mount, PID, network, IPC, and UTS namespaces,
enters a minimal filesystem root, drops all capabilities and supplementary
groups, and sets `no_new_privs` before starting untrusted code.

The untrusted view contains read-only runtime binaries, a namespace-local
`/proc`, and a separate writable `/workspace`. It has no mount of the trusted
temp ancestry, host `/proc`, inherited directory descriptors, or host control
sockets. Its environment contains no credentials. The PID namespace prevents
access to same-UID trusted host processes through host process paths. The
privileged namespace launcher and kernel are trusted; kernel escapes and
malicious administrators are outside this reference's threat model.
This proof addresses filesystem namespace integrity; it does not qualify
resource limits or a complete application sandbox.

The enforcement mechanism is the restricted filesystem and process view for
the entire untrusted process lifetime. A dedicated workload, matching UID,
private directory modes, or removal of an environment setting alone does not
provide that mechanism. Any untrusted descendants must remain under equivalent
restrictions, including during restart and recovery.

## Run the proof

Use a disposable Linux VM or an isolated Crabbox runner with Node, pnpm, Rust,
the package build prerequisites, and util-linux (`unshare`, `mount`, `chroot`,
and `setpriv`). The supervisor needs root to create the namespaces; the host
and untrusted filesystem operations run unprivileged. Build the package and
optionally its native binding first:

```sh
pnpm install --frozen-lockfile
pnpm native:build
pnpm build
sudo env "PATH=$PATH" pnpm proof:temp-isolation
```

Do not run the privileged proof on a production host. It creates only temporary
fixtures and mounts inside its task-owned mount namespaces. The proof fails
when required isolation features are unavailable rather than skipping them.

The unsafe control confirms that the same UID can replace a private root when
given the writable ancestry. The isolated adversary then repeatedly attempts
root/workspace rename, removal/recreation, symlink substitution, and process-root
access while trusted workspace writes and reads continue. It must still be
able to write its permitted workspace. Protected directory identities must stay
unchanged. The adversary remains active across normal stop/start, a killed host
followed by recovery, and overlapping trusted hosts. Normally stopped workspaces
must clean up successfully; the killed host's workspace must remain intact.
The proof runs with native mode `off` and `auto`; `auto` exercises a native
binding only when one has been built and staged.
It stages a root-owned, read-only copy of the runtime for unprivileged trusted
workers, so the invoking checkout can remain private to the runner's login user.
The JSON result records actual native loading, runtime and reference hashes,
and the Node/kernel versions so the proof can be tied to the tested artifacts.

## Applying the result

Retain the exact source revision or candidate content hash, runtime image,
command, configuration, and JSON result. A production deployment needs a review
of its actual mounts, process namespaces, identities, privilege restrictions,
descriptor/socket handoffs, other writers, and lifecycle enforcement against
this contract. Revalidate after changes to that boundary. The library warning
reports reliance on external isolation and does not verify equivalence.

If equivalence cannot be established, keep `trustedWritableAncestors` disabled.
