//! Synthetic FSEvents/dispatch sequencing; CoreFoundation, kqueue and Notify remain real.
#![allow(non_snake_case)]

use super::*;
use crate::watch::{Command, Commands, Pending};
use std::cell::{Cell, RefCell};
use std::sync::{
    Mutex, Weak,
    atomic::{AtomicBool, Ordering},
    mpsc,
};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Scenario {
    CreateFails,
    ExclusionFails,
    StartFails,
    #[default]
    Succeeds,
}

#[derive(Clone)]
struct Probe {
    context: usize,
    owner: Weak<Owner>,
    pending: Weak<Mutex<Pending>>,
}

impl Probe {
    fn check(&self, state: &mut FakeState, phase: &'static str) {
        state.checked.push((phase, self.context));
        match self.owner.upgrade() {
            Some(owner) => {
                if Arc::as_ptr(&owner) as usize != self.context {
                    state.failures.push(format!("{phase}: context does not identify its Owner"));
                }
                if self.pending.as_ptr() != Arc::as_ptr(&owner.pending) {
                    state.failures.push(format!("{phase}: Owner changed its Pending"));
                }
            }
            None => state.failures.push(format!("{phase}: Owner was released before its barrier")),
        }
        if self.pending.upgrade().is_none() {
            state.failures.push(format!("{phase}: Pending was released before its barrier"));
        }
    }
}

struct FakeStream {
    callback: EventCallback,
    probe: Probe,
    scheduled: bool,
    started: bool,
    invalidated: bool,
}

#[derive(Default)]
struct FakeState {
    scenario: Scenario,
    probes: HashMap<usize, Probe>,
    streams: HashMap<usize, Box<FakeStream>>,
    queues: HashMap<usize, Box<u8>>,
    deferred: Vec<Probe>,
    calls: Vec<(&'static str, usize)>,
    checked: Vec<(&'static str, usize)>,
    failures: Vec<String>,
}

thread_local! {
    static FAKE: RefCell<FakeState> = RefCell::new(FakeState::default());
    static BORROW_FAILED: Cell<bool> = const { Cell::new(false) };
}

// Every FFI shim records failures for Rust-side assertions; none asserts or unwraps.
fn fake<T: Default>(work: impl FnOnce(&mut FakeState) -> T) -> T {
    FAKE.with(|cell| match cell.try_borrow_mut() {
        Ok(mut state) => work(&mut state),
        Err(_) => {
            BORROW_FAILED.with(|failed| failed.set(true));
            T::default()
        }
    })
}

fn stream_op(state: &mut FakeState, stream: Ref, name: &'static str) -> Option<Probe> {
    let probe = state.streams.get(&(stream as usize)).map(|stream| stream.probe.clone());
    if let Some(probe) = &probe {
        state.calls.push((name, probe.context));
        probe.check(state, name);
    } else {
        state.failures.push(format!("{name}: unknown or already released stream"));
    }
    probe
}

pub(super) unsafe extern "C" fn FSEventStreamCreate(
    _: Ref,
    callback: EventCallback,
    context: *mut Context,
    _: Ref,
    _: u64,
    _: f64,
    _: u32,
) -> Ref {
    fake(|state| {
        if context.is_null() {
            state.failures.push("Create: missing context".into());
            return null_mut();
        }
        let address = unsafe { (*context).info } as usize;
        state.calls.push(("Create", address));
        let Some(probe) = state.probes.get(&address).cloned() else {
            state.failures.push("Create: no weak Owner witness".into());
            return null_mut();
        };
        probe.check(state, "Create");
        if state.scenario == Scenario::CreateFails {
            return null_mut();
        }
        let mut stream = Box::new(FakeStream {
            callback,
            probe,
            scheduled: false,
            started: false,
            invalidated: false,
        });
        let address = (&mut *stream as *mut FakeStream).cast::<c_void>();
        state.streams.insert(address as usize, stream);
        address
    })
}

pub(super) unsafe extern "C" fn FSEventStreamSetDispatchQueue(stream: Ref, queue: Ref) {
    fake(|state| {
        stream_op(state, stream, "SetDispatchQueue");
        if !state.queues.contains_key(&(queue as usize)) {
            state.failures.push("SetDispatchQueue: unknown queue".into());
        }
        if let Some(stream) = state.streams.get_mut(&(stream as usize)) {
            stream.scheduled = true;
        }
    });
}

pub(super) unsafe extern "C" fn FSEventStreamSetExclusionPaths(stream: Ref, _: Ref) -> u8 {
    fake(|state| {
        stream_op(state, stream, "SetExclusionPaths");
        u8::from(state.scenario != Scenario::ExclusionFails)
    })
}

pub(super) unsafe extern "C" fn FSEventStreamStart(stream: Ref) -> u8 {
    fake(|state| {
        stream_op(state, stream, "Start");
        let succeeds = state.scenario != Scenario::StartFails;
        if let Some(stream) = state.streams.get_mut(&(stream as usize)) {
            if !stream.scheduled || stream.started || stream.invalidated {
                state.failures.push("Start: stream is not ready to start".into());
            }
            stream.started = succeeds;
        }
        u8::from(succeeds)
    })
}

pub(super) unsafe extern "C" fn FSEventStreamStop(stream: Ref) {
    fake(|state| {
        stream_op(state, stream, "Stop");
        if let Some(stream) = state.streams.get_mut(&(stream as usize)) {
            if !stream.started {
                state.failures.push("Stop: stream was never successfully started".into());
            }
            stream.started = false;
        }
    });
}

pub(super) unsafe extern "C" fn FSEventStreamInvalidate(stream: Ref) {
    fake(|state| {
        if let Some(probe) = stream_op(state, stream, "Invalidate") {
            state.deferred.push(probe);
        }
        if let Some(stream) = state.streams.get_mut(&(stream as usize)) {
            if stream.started || stream.invalidated {
                state.failures.push("Invalidate: stream is running or already invalidated".into());
            }
            stream.invalidated = true;
        }
    });
}

pub(super) unsafe extern "C" fn FSEventStreamRelease(stream: Ref) {
    fake(|state| {
        stream_op(state, stream, "Release");
        if let Some(stream) = state.streams.remove(&(stream as usize)) {
            if !stream.invalidated {
                state.failures.push("Release: stream was not invalidated".into());
            }
        }
    });
}

pub(super) unsafe extern "C" fn dispatch_queue_create(_: *const c_char, _: Ref) -> Ref {
    fake(|state| {
        let mut queue = Box::new(0u8);
        let address = (&mut *queue as *mut u8).cast::<c_void>();
        state.queues.insert(address as usize, queue);
        address
    })
}

pub(super) unsafe extern "C" fn dispatch_sync_f(
    queue: Ref,
    context: Ref,
    work: unsafe extern "C" fn(Ref),
) {
    fake(|state| {
        if !state.queues.contains_key(&(queue as usize)) {
            state.failures.push("dispatch: unknown queue".into());
        }
        if std::ptr::fn_addr_eq(work, barrier as unsafe extern "C" fn(Ref)) {
            state.calls.push(("dispatch(barrier)", 0));
            let probes = std::mem::take(&mut state.deferred);
            if probes.is_empty() {
                state.failures.push("barrier: no invalidated stream witness".into());
            }
            for probe in probes {
                probe.check(state, "deferred barrier");
            }
        } else {
            let name = if std::ptr::fn_addr_eq(work, retire as unsafe extern "C" fn(Ref)) {
                "dispatch(retire)"
            } else if std::ptr::fn_addr_eq(work, invalidate_and_release as unsafe extern "C" fn(Ref)) {
                "dispatch(invalidate_and_release)"
            } else {
                state.failures.push("dispatch: unexpected work function".into());
                "dispatch(unknown)"
            };
            stream_op(state, context, name);
        }
    });
    // Release the state borrow before production work reenters the FSEvents shims.
    unsafe { work(context) };
}

pub(super) unsafe extern "C" fn dispatch_release(queue: Ref) {
    fake(|state| {
        state.calls.push(("dispatch_release", 0));
        if state.queues.remove(&(queue as usize)).is_none() {
            state.failures.push("dispatch_release: unknown queue".into());
        }
        if !state.streams.is_empty() || !state.deferred.is_empty() {
            state.failures.push("dispatch_release: stream retirement is incomplete".into());
        }
        if state.probes.values().any(|probe| probe.owner.upgrade().is_some()) {
            state.failures.push("dispatch_release: an Owner is still retained".into());
        }
    });
}

struct Registration {
    id: u32,
    probe: Probe,
    receiver: mpsc::Receiver<Command>,
}

fn register(backend: &mut Backend, id: u32) -> Registration {
    let pending = Arc::new(Mutex::new(Pending { limit: 16, ..Pending::default() }));
    let (sender, receiver) = mpsc::channel();
    let notify = Notify {
        id,
        commands: Commands { sender, waker: backend.waker() },
        queued: Arc::new(AtomicBool::new(false)),
    };
    backend.register(id, "/admitted", pending, notify).unwrap();
    let owner = &backend.owners[&id];
    let probe = Probe {
        context: Arc::as_ptr(owner) as usize,
        owner: Arc::downgrade(owner),
        pending: Arc::downgrade(&owner.pending),
    };
    fake(|state| {
        state.probes.insert(probe.context, probe.clone());
    });
    Registration { id, probe, receiver }
}

fn reset() {
    fake(|state| {
        assert!(state.streams.is_empty() && state.queues.is_empty() && state.deferred.is_empty());
        *state = FakeState::default();
    });
    BORROW_FAILED.with(|failed| failed.set(false));
}

fn assert_clean() {
    assert!(!BORROW_FAILED.with(Cell::get), "reentrant fake-state borrow");
    fake(|state| assert!(state.failures.is_empty(), "{:?}", state.failures));
}

fn assert_calls(expected: &[&str]) {
    fake(|state| {
        let calls = std::mem::take(&mut state.calls);
        assert_eq!(calls.iter().map(|call| call.0).collect::<Vec<_>>(), expected);
    });
    assert_clean();
}

fn assert_error(result: NativeResult<()>, status: &str, reason: &str) {
    let error = result.unwrap_err();
    assert_eq!(error.status, status);
    assert_eq!(error.reason, reason);
}

fn assert_retained(backend: &Backend, registration: &Registration) {
    let owner = &backend.owners[&registration.id];
    assert_eq!(Arc::as_ptr(owner) as usize, registration.probe.context);
    assert_eq!(Arc::strong_count(owner), 1, "fixture must retain only Weak<Owner>");
    assert_eq!(Arc::strong_count(&owner.pending), 1, "fixture must retain only Weak<Pending>");
}

fn assert_removed(backend: &Backend, registration: &Registration) {
    assert!(!backend.owners.contains_key(&registration.id));
    assert!(!backend.streams.contains_key(&registration.id));
    assert!(registration.probe.owner.upgrade().is_none());
    assert!(registration.probe.pending.upgrade().is_none());
}

fn synthetic_callback(backend: &Backend, registration: &Registration) {
    assert_retained(backend, registration);
    let stream = backend.streams[&registration.id].stream;
    let (callback, context) = fake(|state| {
        let stream = &state.streams[&(stream as usize)];
        assert!(stream.scheduled && stream.started && !stream.invalidated);
        (Some(stream.callback), stream.probe.context)
    });
    assert_eq!(context, registration.probe.context);
    let path = CString::new("/admitted/nested/kept").unwrap();
    let paths = [path.as_ptr()];
    let flags = [0x1100];
    for _ in 0..2 {
        unsafe {
            callback.unwrap()(
                null_mut(),
                context as Ref,
                1,
                paths.as_ptr().cast_mut().cast(),
                flags.as_ptr(),
                std::ptr::null(),
            );
        }
    }
    let pending = registration.probe.pending.upgrade().unwrap();
    let batch = pending.lock().unwrap().take().unwrap();
    assert!(!batch.overflow && batch.error.is_none());
    assert_eq!(batch.hints.len(), 1);
    assert_eq!(batch.hints[0].directory, "nested");
    assert_eq!(batch.hints[0].name, "kept");
    assert!(batch.hints[0].structural);
    assert_eq!(batch.hints[0].flags, Some(0x1100));
    assert!(
        matches!(registration.receiver.try_recv(), Ok(Command::Drain(id)) if id == registration.id)
    );
    assert!(registration.receiver.try_recv().is_err());
    backend.owners[&registration.id].notify.queued.store(false, Ordering::Release);
}

const RETIRE: &[&str] = &["dispatch(retire)", "Stop", "Invalidate", "Release", "dispatch(barrier)"];

fn failed_calls(scenario: Scenario, excluded: bool) -> Vec<&'static str> {
    let mut calls = vec!["Create"];
    if scenario == Scenario::CreateFails {
        return calls;
    }
    calls.push("SetDispatchQueue");
    if excluded {
        calls.push("SetExclusionPaths");
    }
    if scenario != Scenario::ExclusionFails {
        calls.push("Start");
    }
    calls.extend(["dispatch(invalidate_and_release)", "Invalidate", "Release", "dispatch(barrier)"]);
    calls
}

fn fails_then_recovers(scenario: Scenario, excluded: bool, replace: bool) {
    reset();
    let mut backend = Backend::new().unwrap();
    let registration = register(&mut backend, 7);
    let anchors = ["/admitted".into()];
    let exclusions: Vec<String> = if excluded { vec!["/admitted/skip".into()] } else { vec![] };
    if replace {
        backend.configure(7, &anchors, &[]).unwrap();
        synthetic_callback(&backend, &registration);
        assert_calls(&["Create", "SetDispatchQueue", "Start"]);
    }
    fake(|state| state.scenario = scenario);
    assert_error(
        backend.configure(7, &anchors, &exclusions),
        "EIO",
        if scenario == Scenario::CreateFails {
            "create FSEvents stream"
        } else {
            "configure/start FSEvents stream"
        },
    );
    let mut expected = if replace { RETIRE.to_vec() } else { vec![] };
    expected.extend(failed_calls(scenario, excluded));
    assert_calls(&expected);
    assert!(!backend.streams.contains_key(&7));
    assert_retained(&backend, &registration);
    {
        let pending = registration.probe.pending.upgrade().unwrap();
        pending.lock().unwrap().overflow();
        assert!(pending.lock().unwrap().take().unwrap().overflow);
    }
    fake(|state| {
        assert!(state.streams.is_empty() && state.deferred.is_empty());
        let barriers = state.checked.iter().filter(|(phase, _)| *phase == "deferred barrier").count();
        assert_eq!(barriers, usize::from(replace) + usize::from(scenario != Scenario::CreateFails));
        state.scenario = Scenario::Succeeds;
    });
    backend.configure(7, &anchors, &exclusions).unwrap();
    let mut expected = vec!["Create", "SetDispatchQueue"];
    if excluded {
        expected.push("SetExclusionPaths");
    }
    expected.push("Start");
    assert_calls(&expected);
    synthetic_callback(&backend, &registration);
    backend.remove(7).unwrap();
    assert_calls(RETIRE);
    assert_removed(&backend, &registration);
    drop(backend);
    assert_calls(&["dispatch_release"]);
}

#[test]
fn create_failure_preserves_owner_and_recovers() {
    fails_then_recovers(Scenario::CreateFails, false, false);
}

#[test]
fn rejected_exclusions_invalidate_without_stopping_and_recover() {
    fails_then_recovers(Scenario::ExclusionFails, true, false);
}

#[test]
fn failed_start_with_and_without_exclusions_never_stops_and_recovers() {
    for excluded in [false, true] {
        fails_then_recovers(Scenario::StartFails, excluded, false);
    }
}

#[test]
fn failed_reconfiguration_retires_old_coverage_and_preserves_owner() {
    for (scenario, excluded) in [
        (Scenario::CreateFails, false),
        (Scenario::ExclusionFails, true),
        (Scenario::StartFails, false),
        (Scenario::StartFails, true),
    ] {
        fails_then_recovers(scenario, excluded, true);
    }
}

#[test]
fn duplicate_registration_preserves_owner_and_active_stream() {
    reset();
    let mut backend = Backend::new().unwrap();
    let registration = register(&mut backend, 9);
    backend.configure(9, &["/admitted".into()], &[]).unwrap();
    assert_calls(&["Create", "SetDispatchQueue", "Start"]);
    let stream = backend.streams[&9].stream;
    let pending = Arc::new(Mutex::new(Pending::default()));
    let rejected_pending = Arc::downgrade(&pending);
    let (sender, receiver) = mpsc::channel();
    let notify = Notify {
        id: 9,
        commands: Commands { sender, waker: backend.waker() },
        queued: Arc::new(AtomicBool::new(false)),
    };

    assert_error(
        backend.register(9, "/replacement", pending, notify),
        "EINVAL",
        "duplicate watch registration",
    );
    assert_calls(&[]);
    assert!(rejected_pending.upgrade().is_none());
    assert_eq!(backend.streams[&9].stream, stream);
    synthetic_callback(&backend, &registration);
    assert!(matches!(receiver.try_recv(), Err(mpsc::TryRecvError::Disconnected)));

    backend.remove(9).unwrap();
    assert_calls(RETIRE);
    assert_removed(&backend, &registration);
    drop(backend);
    assert_calls(&["dispatch_release"]);
}

#[test]
fn invalid_paths_preserve_the_active_stream() {
    reset();
    let mut backend = Backend::new().unwrap();
    let registration = register(&mut backend, 11);
    let anchors = vec!["/admitted".into()];
    backend.configure(11, &anchors, &[]).unwrap();
    assert_calls(&["Create", "SetDispatchQueue", "Start"]);
    let stream = backend.streams[&11].stream;
    for (anchors, exclusions, reason) in [
        (vec!["/outside".into()], vec![], "watch path outside Root"),
        (anchors.clone(), vec!["/outside".into()], "watch path outside Root"),
        (
            vec!["/admitted/../outside".into()],
            vec![],
            "relative path must not contain '..'",
        ),
        (
            vec!["/admitted/with\0nul".into()],
            vec![],
            "relative path contains a NUL byte",
        ),
        (vec!["/admitted".into(); 129], vec![], "invalid FSEvents path count"),
        (anchors.clone(), vec!["/admitted/skip".into(); 9], "invalid FSEvents path count"),
    ] {
        assert_error(backend.configure(11, &anchors, &exclusions), "EINVAL", reason);
        assert_calls(&[]);
        assert_eq!(backend.streams[&11].stream, stream);
        synthetic_callback(&backend, &registration);
    }
    backend.remove(11).unwrap();
    assert_calls(RETIRE);
    assert_removed(&backend, &registration);
    drop(backend);
    assert_calls(&["dispatch_release"]);
}

#[test]
fn empty_anchors_keep_entry_owner_and_later_streams_work() {
    reset();
    let mut backend = Backend::new().unwrap();
    let registration = register(&mut backend, 13);
    let anchors = ["/admitted".into()];
    for _ in 0..2 {
        backend.configure(13, &anchors, &[]).unwrap();
        assert_calls(&["Create", "SetDispatchQueue", "Start"]);
        synthetic_callback(&backend, &registration);
        backend.configure(13, &[], &["/admitted/skip".into()]).unwrap();
        assert_calls(RETIRE);
        assert!(!backend.streams.contains_key(&13));
        assert_retained(&backend, &registration);
        assert_eq!(backend.entries(13, vec![]).unwrap().directories, 0);
    }
    backend.remove(13).unwrap();
    assert_calls(&[]);
    assert_removed(&backend, &registration);
    drop(backend);
    assert_calls(&["dispatch_release"]);
}

#[test]
fn map_growth_and_backend_drop_keep_all_contexts_through_retirement() {
    reset();
    let mut backend = Backend::new().unwrap();
    let mut registrations = vec![register(&mut backend, 1), register(&mut backend, 2)];
    let initial_capacity = backend.owners.capacity();
    let anchors = ["/admitted".into()];
    for id in 1..=2 {
        backend.configure(id, &anchors, &[]).unwrap();
    }
    for id in 3..=192 {
        registrations.push(register(&mut backend, id));
        if id % 32 == 0 {
            backend.configure(id, &anchors, &[]).unwrap();
            synthetic_callback(&backend, &registrations[0]);
            synthetic_callback(&backend, &registrations[1]);
        }
    }
    assert!(backend.owners.capacity() > initial_capacity);
    for registration in &registrations {
        assert_retained(&backend, registration);
    }
    let contexts: Vec<_> = registrations
        .iter()
        .filter(|r| backend.streams.contains_key(&r.id))
        .map(|r| r.probe.context)
        .collect();
    for registration in &registrations {
        if backend.streams.contains_key(&registration.id) {
            synthetic_callback(&backend, registration);
        }
    }
    assert_clean();
    fake(|state| state.calls.clear());
    backend.remove(1).unwrap();
    assert_removed(&backend, &registrations[0]);
    drop(backend);
    for registration in &registrations {
        assert!(registration.probe.owner.upgrade().is_none());
        assert!(registration.probe.pending.upgrade().is_none());
    }
    fake(|state| {
        assert_eq!(state.calls.pop(), Some(("dispatch_release", 0)));
        assert_eq!(state.calls.len(), contexts.len() * RETIRE.len());
        for calls in state.calls.chunks_exact(RETIRE.len()) {
            assert_eq!(calls.iter().map(|call| call.0).collect::<Vec<_>>(), RETIRE);
            assert!(calls[..4].iter().all(|call| call.1 == calls[0].1));
        }
        for context in contexts {
            assert_eq!(state.calls.iter().filter(|call| **call == ("Stop", context)).count(), 1);
            assert_eq!(state.calls.iter().filter(|call| **call == ("Release", context)).count(), 1);
            assert_eq!(
                state.checked.iter().filter(|call| **call == ("deferred barrier", context)).count(),
                1,
            );
        }
        assert!(state.streams.is_empty() && state.deferred.is_empty() && state.queues.is_empty());
    });
    assert_clean();
}

#[test]
fn decoder_preserves_inside_names_and_discards_outside_paths() {
    reset();
    let mut backend = Backend::new().unwrap();
    let registration = register(&mut backend, 1);
    let pending = Arc::new(Mutex::new(Pending { limit: 2, ..Pending::default() }));
    let events = Owner {
        root: "/admitted/".into(),
        pending: pending.clone(),
        notify: backend.owners[&registration.id].notify.clone(),
    };
    events.record(b"/admitted/kept", 0x1000);
    let batch = pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().unwrap();
    assert!(!batch.overflow);
    assert_eq!(batch.hints.len(), 1);
    assert_eq!(batch.hints[0].name, "kept");
    for root in ["/admitted", "/admitted/", "/"] {
        let events = Owner { root: root.into(), pending: pending.clone(), notify: events.notify.clone() };
        events.record(root.as_bytes(), 0x1400);
        let batch = pending.lock().unwrap().take().expect("Root metadata must reconcile");
        assert!(batch.overflow && batch.hints.is_empty());
    }
    for path in ["/admitted-other/private", "/admitted/../private", "/outside/private"] {
        events.record(path.as_bytes(), 0x1000);
        assert!(pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().is_none());
    }
    for (path, directory) in [(b"/admitted/selected/\xff".as_slice(), "selected"),
        (b"/admitted/selected/\xff/deeper".as_slice(), "selected"), (b"/admitted/\xff".as_slice(), ""),
        (b"/admitted/selected/partial\xff/deeper".as_slice(), "selected"),
        (b"/admitted/partial\xff/deeper".as_slice(), ""),
        (b"/admitted/caf\xc3\xa9/partial\xc3".as_slice(), "café")] {
        events.record(path, 0x1000);
        let batch = pending.lock().unwrap().take().unwrap();
        assert!(!batch.overflow);
        assert_eq!(batch.hints[0].directory, directory);
        assert_eq!(batch.hints[0].nameless_child, Some(true));
        assert!(batch.hints[0].name.is_empty());
    }
    for path in [b"/admitted-other/\xff".as_slice(), b"/admitted/../\xff".as_slice(),
        b"/admitted/\xff/../private".as_slice(), b"/admitted/\xff//private".as_slice()] {
        events.record(path, 0x1000);
        assert!(pending.lock().unwrap().take().is_none());
    }
    for flags in [1, 2, 4, 8, 32, 128] {
        events.record(b"/admitted/selected/file", flags | 0x1000);
        let batch = pending.lock().unwrap().take().unwrap();
        assert!(batch.overflow && batch.hints.is_empty());
    }
    drop(events);
    backend.remove(registration.id).unwrap();
    drop(backend);
    assert_calls(&["dispatch_release"]);
}
