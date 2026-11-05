//! Scope timers for profiling the engine (`--features prof`): every
//! `prof!("name")` adds the time to the end of its scope to a per-thread
//! table (inclusive: nested scopes count in both). Without the feature the
//! macro expands to nothing.

#[cfg(feature = "prof")]
mod imp {
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};

    thread_local! {
        static TABLE: RefCell<BTreeMap<&'static str, (Duration, u64)>> = RefCell::new(BTreeMap::new());
    }

    pub struct Guard {
        name: &'static str,
        start: Instant,
    }

    impl Guard {
        pub fn new(name: &'static str) -> Guard {
            Guard { name, start: Instant::now() }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            let d = self.start.elapsed();
            TABLE.with(|t| {
                let mut t = t.borrow_mut();
                let e = t.entry(self.name).or_default();
                e.0 += d;
                e.1 += 1;
            });
        }
    }

    /// (name, seconds, calls), and the table cleared.
    pub fn take() -> Vec<(&'static str, f64, u64)> {
        TABLE.with(|t| std::mem::take(&mut *t.borrow_mut()).into_iter().map(|(k, (d, n))| (k, d.as_secs_f64(), n)).collect())
    }
}

#[cfg(feature = "prof")]
pub use imp::{take, Guard};

/// Without the feature: nothing recorded.
#[cfg(not(feature = "prof"))]
pub fn take() -> Vec<(&'static str, f64, u64)> {
    Vec::new()
}

#[macro_export]
macro_rules! prof {
    ($name:expr) => {
        #[cfg(feature = "prof")]
        let _prof_guard = $crate::prof::Guard::new($name);
    };
}
