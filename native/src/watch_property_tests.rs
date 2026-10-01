use super::{HintKind, Pending};

#[test]
fn seeded_pending_streams_preserve_coverage_flags_and_bounds() {
    // No new dependency: fixed xorshift seeds retain replayable transport streams.
    for seed in 1..=512_u64 {
        let mut random = seed;
        let mut next = || {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            random
        };
        let limit = 1 + seed as usize % 8;
        let mut pending = Pending { limit, ..Default::default() };
        let mut reference = Vec::new();
        for step in 0..128 {
            let directory = match next() % 5 {
                0 => String::new(),
                1 => "a".into(),
                2 => "ab".into(),
                3 => std::path::Path::new("a").join("café").to_string_lossy().into_owned(),
                _ => std::path::Path::new("b").join(format!("d{}", next() % 8)).to_string_lossy().into_owned(),
            };
            let children = next() % 7 == 0;
            let name = if children { String::new() } else { format!("f{}", next() % 16) };
            let structural = children || next() % 2 == 0;
            let flags = 1_u32 << (next() % 24);
            let kind = if children { HintKind::Children } else { HintKind::Entry };
            reference.push((directory.clone(), name.clone(), kind, structural, flags));
            pending.push_hint(directory, name, structural, Some(flags), kind);
            assert!(!pending.overflow, "seed {seed}, step {step}: pressure is not loss");
            assert!(pending.paths.len() <= limit);
            for (directory, name, kind, structural, flags) in &reference {
                let covered = pending.paths.iter().any(|((parent, leaf, retained), value)| {
                    let covers = if *retained == HintKind::Subtree {
                        parent.is_empty() || std::path::Path::new(directory).starts_with(parent)
                    } else { directory == parent && name == leaf && kind == retained };
                    covers && (!structural || value.0) && value.1.unwrap_or(0) & flags == *flags
                });
                assert!(covered, "seed {seed}, step {step}: dropped {directory}/{name}");
            }
            if next() % 5 == 0 {
                let batch = pending.take().unwrap();
                if next() % 2 == 0 { pending.restore(batch); }
                else { reference.clear(); }
            }
        }
        pending.overflow();
        let batch = pending.take().unwrap();
        assert!(batch.overflow && batch.hints.is_empty());
        assert!(pending.take().is_none());
    }
}
