use std::{alloc::{Layout, alloc, dealloc}, ffi::c_void, ptr};

const ALIGN: usize = 16;

pub unsafe extern "C" fn allocate(_opaque: *mut c_void, size: usize) -> *mut c_void {
    #[cfg(feature = "allocator-tests")]
    if !tests::admit() { return ptr::null_mut(); }
    let Some(total) = size.checked_add(ALIGN) else { return ptr::null_mut(); };
    let Ok(layout) = Layout::from_size_align(total, ALIGN) else { return ptr::null_mut(); };
    let allocation = unsafe { alloc(layout) };
    if allocation.is_null() { return ptr::null_mut(); }
    // C callbacks do not provide a size when freeing; retain its exact layout.
    unsafe { allocation.cast::<usize>().write(total); }
    #[cfg(feature = "allocator-tests")]
    tests::allocated();
    unsafe { allocation.add(ALIGN).cast() }
}

pub unsafe extern "C" fn release(_opaque: *mut c_void, address: *mut c_void) {
    if address.is_null() { return; }
    let allocation = unsafe { address.cast::<u8>().sub(ALIGN) };
    let total = unsafe { allocation.cast::<usize>().read() };
    let layout = unsafe { Layout::from_size_align_unchecked(total, ALIGN) };
    unsafe { dealloc(allocation, layout); }
    #[cfg(feature = "allocator-tests")]
    tests::released();
}

#[cfg(feature = "allocator-tests")]
mod tests {
    use std::cell::Cell;

    thread_local! {
        static REMAINING: Cell<Option<usize>> = const { Cell::new(None) };
        static LIVE: Cell<usize> = const { Cell::new(0) };
        static ATTEMPTS: Cell<usize> = const { Cell::new(0) };
    }
    static mut LAST_ADDRESS: usize = 0;

    pub fn admit() -> bool {
        ATTEMPTS.with(|counter| counter.set(counter.get() + 1));
        REMAINING.with(|counter| match counter.get() {
            None => true,
            Some(0) => false,
            Some(remaining) => { counter.set(Some(remaining - 1)); true }
        })
    }
    pub fn allocated() { LIVE.with(|counter| counter.set(counter.get() + 1)); }
    pub fn released() { LIVE.with(|counter| counter.set(counter.get() - 1)); }

    #[unsafe(no_mangle)]
    pub extern "C" fn test_allocator_limit(remaining: i32) {
        REMAINING.with(|counter| counter.set(if remaining < 0 { None } else { Some(remaining as usize) }));
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn test_allocator_live() -> usize { LIVE.with(Cell::get) }
    #[unsafe(no_mangle)]
    pub extern "C" fn test_allocator_attempts() -> usize { ATTEMPTS.with(Cell::get) }
    #[unsafe(no_mangle)]
    pub extern "C" fn test_allocator_probe(size: usize) -> i32 {
        let pointer = unsafe { super::allocate(std::ptr::null_mut(), size) };
        if pointer.is_null() { return -1; }
        // Prevent allocation elision so this tests the actual allocator and LTO output.
        unsafe { (&raw mut LAST_ADDRESS).write_volatile(pointer as usize); }
        unsafe { super::release(std::ptr::null_mut(), pointer); }
        0
    }
}
