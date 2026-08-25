# Changelog

## 1.0.0

First stable release. `0.0.2` was a copy of Svelte 3's store; this is a port of Svelte 5's, with a parity test suite that runs against the real `svelte/store` to keep it honest.

The version is a deliberate jump to `1.0.0` rather than `0.1.0`: at `0.0.x` a `^` range is an exact pin, so every consumer on a different patch got its own copy of the module. `^1.0.0` ranges deduplicate normally.

### Added

- `readonly`.
- The start notifier receives `(set, update)`, and `derived`'s callback receives `(values, set, update)`, matching Svelte 4 and 5.
- `derived` throws `derived() expects stores as input, got a falsy value` instead of failing obscurely later.
- The notification queue is shared between copies of the module via `Symbol.for('sveltore.subscriber_queue.v1')` on `globalThis`, so duplicate installs and separate bundles keep Svelte's update-flattening guarantee across the boundary. This is why sveltore does not need to be a peer dependency.
- An `exports` map with correct ESM and CJS type declarations, plus `sideEffects: false`, `engines` and repository metadata.
- Test suite: parity against `svelte/store`, cross-copy queue behaviour, and a characterisation of the one deviation.
- `bench/`, measuring the cost of that deviation and whether `try` still deoptimizes, so the decision can be re-checked on future runtimes rather than taken on trust.

### Changed

- **Deviation from Svelte:** a subscriber that throws during a flush no longer wedges the queue permanently. Svelte clears the queue only on the happy path, so a throwing subscriber silently kills all further notifications; here the reset is in a `finally`. The error still propagates and the interrupted batch is still dropped. See `test/deviation-throwing-subscriber.test.ts`, and `bench/` for the measured cost of the `try` (median +0.6% per `set`, no deoptimization on TurboFan).
- `derived` correctly stops recomputing after its last unsubscribe (Svelte's `started = false` fix).
- `safe_not_equal` matches Svelte 5's formulation (behaviourally identical).
- License corrected from ISC to MIT, which is what the ported Svelte code is under, with the Svelte copyright reproduced.

### Removed

- Svelte 3 component internals that `0.0.2` exported by accident: `assign`, `is_promise`, `add_location`, `run`, `blank_object`, `run_all`, `is_function`, `safe_not_equal`, `src_url_equal`, `not_equal`, `is_empty`, `validate_store`, `subscribe`, `component_subscribe`, `create_slot`, `get_slot_changes`, `update_slot`, `update_slot_base`, `get_all_dirty_from_scope`, `exclude_internal_props`, `compute_rest_props`, `compute_slots`, `once`, `null_to_empty`, `set_store_value`, `has_prop`, `action_destroyer`. None of them were store related. `noop` and `identity` are kept.
- The `Invalidator<T>` type, matching Svelte 5: `subscribe`'s second argument is typed `() => void`.

## 0.0.2

Initial publish: a copy of Svelte 3's store implementation.
