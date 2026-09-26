//! Read-only allocation accounting for watch memory diagnostics.
use napi_derive::napi;
use std::sync::atomic::{AtomicU32, Ordering};

static PENDING: AtomicU32 = AtomicU32::new(0);
static PAYLOADS: AtomicU32 = AtomicU32::new(0);
static PAYLOADS_CREATED: AtomicU32 = AtomicU32::new(0);
static PAYLOADS_DESTROYED: AtomicU32 = AtomicU32::new(0);
static TSFNS: AtomicU32 = AtomicU32::new(0);
static TSFNS_CREATED: AtomicU32 = AtomicU32::new(0);
static TSFNS_DESTROYED: AtomicU32 = AtomicU32::new(0);

// Zero-sized fields preserve the measured native allocation sizes.
pub(super) struct PendingLifetime;
impl Default for PendingLifetime {
    fn default() -> Self {
        PENDING.fetch_add(1, Ordering::SeqCst);
        Self
    }
}
impl Drop for PendingLifetime {
    fn drop(&mut self) {
        PENDING.fetch_sub(1, Ordering::SeqCst);
    }
}
pub(super) struct PayloadLifetime;
impl Default for PayloadLifetime {
    fn default() -> Self {
        PAYLOADS_CREATED.fetch_add(1, Ordering::SeqCst);
        PAYLOADS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}
impl Drop for PayloadLifetime {
    fn drop(&mut self) {
        PAYLOADS.fetch_sub(1, Ordering::SeqCst);
        PAYLOADS_DESTROYED.fetch_add(1, Ordering::SeqCst);
    }
}
pub(super) fn tsfn_created() {
    TSFNS_CREATED.fetch_add(1, Ordering::SeqCst);
    TSFNS.fetch_add(1, Ordering::SeqCst);
}
pub(super) fn tsfn_destroyed() {
    TSFNS.fetch_sub(1, Ordering::SeqCst);
    TSFNS_DESTROYED.fetch_add(1, Ordering::SeqCst);
}
#[napi(object)]
pub struct WatchMemoryStats {
    pub registrations: u32,
    pub pending_sets: u32,
    pub payloads_live: u32,
    pub payloads_created: u32,
    pub payloads_destroyed: u32,
    pub threadsafe_functions_live: u32,
    pub threadsafe_functions_created: u32,
    pub threadsafe_functions_destroyed: u32,
}
pub(super) fn snapshot(registrations: u32) -> WatchMemoryStats {
    WatchMemoryStats {
        registrations,
        pending_sets: PENDING.load(Ordering::SeqCst),
        payloads_live: PAYLOADS.load(Ordering::SeqCst),
        payloads_created: PAYLOADS_CREATED.load(Ordering::SeqCst),
        payloads_destroyed: PAYLOADS_DESTROYED.load(Ordering::SeqCst),
        threadsafe_functions_live: TSFNS.load(Ordering::SeqCst),
        threadsafe_functions_created: TSFNS_CREATED.load(Ordering::SeqCst),
        threadsafe_functions_destroyed: TSFNS_DESTROYED.load(Ordering::SeqCst),
    }
}
