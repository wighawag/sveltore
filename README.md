# sveltore

**Svelte's store implementation, as a standalone package with no dependencies.**

For libraries that want to hand back a reactive value that works with `$store` in a Svelte app, without forcing Svelte on consumers who are on React, on vanilla JS, or on a server. Depending on `svelte` just to call `writable` drags the compiler into your install graph and into every consumer's peer-dependency negotiation, in exchange for about a hundred lines that have nothing to do with compiling anything.

```sh
npm i sveltore
```

```js
import { writable, readable, derived, readonly, get } from 'sveltore';

const count = writable(0);
const double = derived(count, ($count) => $count * 2);

count.set(2);
get(double); // 4
```

Stores from this package satisfy the [Svelte store contract](https://svelte.dev/docs/svelte/stores#Store-contract), so in a Svelte app `$store` auto-subscription works on them directly, as do `svelte/store`'s own `get`, `derived` and `fromStore`. No adapter, no wrapper.

## Relationship to `svelte/store`

This is a port of `svelte/store`, tracking **svelte 5.56.10** (whose store implementation is unchanged since 5.25). The public API is a strict **subset**, with identical signatures and identical semantics.

| Export                                                                                                         | Status                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writable`, `readable`, `derived`, `readonly`, `get`                                                           | Identical                                                                                                                                                                                                                                                           |
| `Readable`, `Writable`, `Subscriber`, `Unsubscriber`, `Updater`, `StartStopNotifier`, `Stores`, `StoresValues` | Identical types                                                                                                                                                                                                                                                     |
| `toStore`, `fromStore`                                                                                         | **Absent.** They bridge stores to Svelte runes (`$state` / `$effect`) and cannot exist without the Svelte runtime. If you need them you already have Svelte, so import them from `svelte/store` and pass any store from here straight in: the contract is the same. |

Parity is enforced rather than asserted. [`test/parity.test.ts`](./test/parity.test.ts) runs one suite against **both** `sveltore` and the real `svelte/store` via `describe.each`, so the two cannot silently drift.

There is exactly one intentional behavioural difference, [described below](#one-deliberate-difference-from-svelte).

## Using a single implementation in a Svelte app

Because the API is a strict subset, a Svelte app that would rather have exactly one store implementation in its bundle can alias this package away entirely:

```js
// vite.config.js
export default {
	resolve: {
		alias: {
			sveltore: 'svelte/store'
		}
	}
};
```

Every `import ... from 'sveltore'` in your dependencies then resolves to Svelte's own module. Nothing else changes, and you get one shared notification queue across your app and your dependencies.

This is deliberately a **consumer** decision rather than something the package sniffs out at runtime, because runtime detection cannot be made to work:

- A static `import 'svelte/store'` inside sveltore would make Svelte a hard dependency again and break the build for everyone who does not have it. Bundlers resolve imports at build time, where no `try`/`catch` can help.
- A dynamic `await import('svelte/store')` is asynchronous and cannot back a synchronous `writable()`, would break the CJS build, and bundlers still try to resolve the specifier.
- Worst of all, which implementation you got would then depend on bundler resolution, so one app could end up with Svelte's in one chunk and the fallback in another. Non-determinism is worse than a consistent second copy.

An alias is one line, deterministic, and costs non-Svelte consumers nothing.

## The notification queue is shared between copies

Svelte flattens cascading updates through a module-level queue, so that a subscriber which sets another store does not re-enter: every subscriber of the first store is notified before the second store's subscribers run. That is what stops a subscriber from observing an inconsistent half of a diamond dependency, and it holds only for stores that share one queue.

A module-level queue quietly stops being one queue as soon as the module is duplicated: two versions in a dependency tree, two bundles, a micro-frontend, a server graph and a client graph. Svelte has this problem too (it is one reason duplicate `svelte` installs misbehave) and its queue is module-private, so nothing outside can do anything about it.

Here the queue lives on `globalThis` under `Symbol.for('sveltore.subscriber_queue.v1')`, so every copy of sveltore in a realm cooperates in one queue and the ordering guarantee survives the boundary. The key is versioned because the shared contract is the queue's layout: a future incompatible layout takes a new key and degrades to per-copy queues rather than corrupting a queue it does not understand.

Two consequences worth stating outright:

- **You do not need to make `sveltore` a peer dependency.** Depend on it normally. A peer dependency would push an install burden onto apps that never import it, and would not even guarantee a single instance across bundler boundaries, whereas the shared queue makes duplication harmless. Deduplication is still nice for bundle size, and `^1.0.0` ranges dedupe on their own.
- **The queue still cannot be shared with Svelte's own,** which is module-private and unreachable. Mixing sveltore stores and `svelte/store` stores in one cascade re-enters, exactly as two unshared copies would. That limitation is pinned down by a test in [`test/sveltore-specific.test.ts`](./test/sveltore-specific.test.ts) rather than left to be discovered. If it affects you, use the alias above.

## One deliberate difference from Svelte

Svelte empties the notification queue only on the happy path:

```js
if (run_queue) {
	for (let i = 0; i < subscriber_queue.length; i += 2) {
		subscriber_queue[i][0](subscriber_queue[i + 1]);
	}
	subscriber_queue.length = 0; // never reached if a subscriber throws
}
```

A subscriber that **throws** therefore leaves the queue permanently non-empty. Every later `set` sees a non-empty queue, assumes another flush already owns it, appends to it and returns. Nothing drains it again, so the entire store system goes silent, with no error and no way back.

sveltore puts that reset in a `finally`. A throwing subscriber still propagates its error, and the interrupted batch is still dropped, but the store system remains usable afterwards. This matters more here than upstream, because a wedged queue would take down every copy of sveltore sharing it.

Both sides of this are specified in [`test/deviation-throwing-subscriber.test.ts`](./test/deviation-throwing-subscriber.test.ts), which asserts what sveltore does **and** characterises what `svelte/store` does. If Svelte ever fixes this upstream, that test goes red, which is the signal that the deviation is obsolete and this package can go back to being a straight port.

No non-throwing path is affected, so the alias in the previous section stays safe.

### Is the `finally` a performance problem?

The natural objection is that Svelte omits it deliberately, because `try` is expensive. That was a real concern in the era this code comes from: under V8's old Crankshaft compiler a function containing `try` was never optimized at all. It has not been true since TurboFan, and Svelte 5's own signal runtime now uses `try`/`catch`/`finally` in `update_reaction`, the hottest function it has. No upstream issue or comment stating a rationale seems to exist, so the likeliest explanation is simply that `svelte/store` is frozen legacy code from before runes, carrying an idiom from when it mattered.

Rather than argue it, [`bench/`](./bench) measures it, so the decision can be re-checked on a future runtime instead of taken on trust:

```sh
node bench/finally-overhead.mjs                              # cost of the finally
node --allow-natives-syntax bench/v8-optimization-status.mjs # does it still deoptimize?
```

On node 22, the flush path with and without the `finally` reports the **identical** V8 optimization status (`Optimized, TurboFanned`), so the deoptimization concern is gone.

What is left, over 8 runs of 41 alternating rounds each, is a median of **+0.6% per `set()`**, a few nanoseconds:

| Scenario         | Median delta | Range            |
| ---------------- | ------------ | ---------------- |
| 1 subscriber     | +0.22%       | -0.75% .. +0.80% |
| 8 subscribers    | -0.22%       | -1.89% .. +0.97% |
| cascade, depth 5 | +1.83%       | +0.41% .. +4.35% |

The two fan-out cases straddle zero, so the effect there is smaller than the run-to-run noise. Only the cascade, where the flush calls subscribers that themselves call `set`, is consistently positive, at under 2%. And this is a deliberate worst case: the subscriber is the cheapest one that can be written (`acc += v`), so the flush overhead is essentially the entire measurement. Any real subscriber does enough work to push the relative cost toward zero.

A couple of nanoseconds per `set` is a fair price for the guarantee that one throwing subscriber cannot silently kill every store in the process. If you disagree for your workload, the alias above gets you Svelte's exact implementation instead.

## Upgrading from 0.0.x

`0.0.2` was a copy of **Svelte 3**'s store. If you only ever called `writable`, `readable`, `derived` and `get`, this is a drop-in upgrade. Otherwise:

- `readonly` is new.
- The start notifier now receives `(set, update)`, and `derived`'s callback receives `(values, set, update)`. This is additive, matching Svelte 4 and 5.
- `derived` now throws on a falsy store instead of failing obscurely later, and correctly stops recomputing after its last unsubscribe.
- The `Invalidator<T>` type is gone, matching Svelte 5: `subscribe`'s second argument is typed `() => void`.
- Svelte 3 component internals that were exported by accident (`assign`, `is_promise`, `create_slot`, `add_location`, `src_url_equal` and friends) are gone. `noop` and `identity` are kept.
- The package now ships an `exports` map with correct ESM and CJS type declarations.

## License

MIT, as a port of MIT-licensed Svelte code. See [LICENSE](./LICENSE).
