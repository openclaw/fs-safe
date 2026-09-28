# Adversarial Root race fuzzer

The optional `--dwell-scale=N` multiplier changes both hostile-state and
restored-directory dwell intervals. The default `1` preserves the original
0–0.4 ms intervals; `20` exercises 0–8 ms intervals so longer guarded operations
can reach publication instead of only failing admission. Configuration records
include the scale. Keep fast and longer-dwell observations separate, retain
incomplete attempts, and require the same strict effect, success, and attacker
overlap checks for each campaign; changing timing is not evidence that an
incomplete campaign passed.

Build JavaScript and the host native addon before running. Each seed creates
isolated disposable fixtures, races selected Root operations against separate
attacker processes, joins those processes, and records exact sentinel snapshots.
The output path must not already exist.

```sh
pnpm build
pnpm native:build
node scripts/root-race/run.mjs --mode=require --control=quiet --seeds=1 --seconds=0 --output=quiet.jsonl
node scripts/root-race/run.mjs --mode=require --control=oracle --seeds=1 --seconds=0 --output=oracle.jsonl
node scripts/root-race/run.mjs --mode=require --ops=remove,removeTree,rename,mkdir,appendCreate --seeds=60 --seconds=20 --output=races.jsonl
FS_SAFE_TEST_NO_OPENAT2=1 node scripts/root-race/run.mjs --mode=require --ops=remove,removeTree --seeds=60 --seconds=20 --output=fallback.jsonl
```

`--seed=N` selects the starting seed. A seed fixes choices, not kernel scheduling.
`--kind=parent-symlink|retarget|directory-replace|hardlink|type-flip|ancestor`
selects one attacker shape; otherwise shapes rotate. A seed uses one to four
attackers, with a single namespace owner for ancestor swaps. Each reported
attacker must demonstrate successful activity during the victim interval.
`appendCreate` uses a separately replenished missing basename to exercise file
creation directly; `append` also covers already-existing files.

Strict mode exits 1 for observed effects, 2 for incomplete coverage, and 0 only
when neither occurred. Every selected operation needs a successful call within
each seed; any `helper-unavailable` result makes that seed incomplete, even when
mixed with successful calls or ordinary race rejections. Unverified published copies and content reads after sentinel
corruption are also inconclusive. `--control=oracle` performs one victim call,
deliberately changes an outside sentinel, and passes only when that corruption
is detected. It is a calibration check, not a product confinement result.

For exploratory contract classification, `--verdict=observe` records the same
observations without treating them as an exit-status gate. This mode never
certifies a clean security result. Effects are observation events, including
effects of calls that throw; they are not independent vulnerability counts.
Interpret FileStore's fresh roots, temporary-directory helpers, advisory reads,
and platform-specific best-effort mechanisms against their own contracts.

`campaign.mjs` runs three Linux configurations and preserves their separate
logs under a new `.artifacts/campaign-*` directory. The bootstrap scripts are
examples for already authorized disposable machines; they do not acquire or
release machines. The POSIX scripts require the repository's Rust/WASM build
toolchain, and the Windows script requires an appropriate native build setup.

A zero-observation run covers only its recorded source, operations, attack
shapes, runtime, filesystem and duration. It is not proof for every schedule or
an unavailable platform/backend. Preserve configuration rows, coverage flags,
per-operation metrics, source provenance, and final completion records.
