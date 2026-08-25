// Does the `finally` in src/store.ts cost anything?
//
// sveltore deviates from svelte in one place: the notification queue is emptied in a `finally`, so
// that a subscriber which throws cannot wedge the queue forever (see
// test/deviation-throwing-subscriber.test.ts). The obvious objection is that svelte omits it for
// performance, since `try` used to prevent a function from being optimized at all under V8's old
// Crankshaft compiler, which is roughly the era svelte's store code comes from.
//
// That is no longer true under TurboFan, and this file is here so the claim can be re-checked
// rather than believed. Run it with:
//
//     node bench/finally-overhead.mjs
//
// The other half of the old objection, that `try` makes a function unoptimizable outright, is
// checked separately by bench/v8-optimization-status.mjs.
//
// Results are reported per `set()` call, because the `finally` runs once per FLUSH, not once per
// subscriber notified. Quoting it per notification would understate it at high fan-out.
//
// Measured on node 22 (2025): a low single-digit ns per set, against a set that already costs tens
// of ns with the cheapest possible subscriber (`acc += v`). This benchmark is therefore a worst
// case: any real subscriber does enough work to push the relative cost toward zero. For reference,
// svelte 5's own signal runtime uses try/catch/finally in `update_reaction`, the hottest function
// it has.

/** Builds the flush path twice, identical except for the construct under test. */
function make(use_finally) {
	const subscriber_queue = [];
	const noop = () => {};
	const safe_not_equal = (a, b) =>
		a != a ? b == b : a !== b || (a !== null && typeof a === 'object') || typeof a === 'function';

	return function writable(value, start = noop) {
		let stop = null;
		const subscribers = new Set();

		function set(new_value) {
			if (safe_not_equal(value, new_value)) {
				value = new_value;
				if (stop) {
					const run_queue = !subscriber_queue.length;
					for (const subscriber of subscribers) {
						subscriber[1]();
						subscriber_queue.push(subscriber, value);
					}
					if (run_queue) {
						if (use_finally) {
							try {
								for (let i = 0; i < subscriber_queue.length; i += 2) {
									subscriber_queue[i][0](subscriber_queue[i + 1]);
								}
							} finally {
								subscriber_queue.length = 0;
							}
						} else {
							for (let i = 0; i < subscriber_queue.length; i += 2) {
								subscriber_queue[i][0](subscriber_queue[i + 1]);
							}
							subscriber_queue.length = 0;
						}
					}
				}
			}
		}

		return {
			set,
			update: (fn) => set(fn(value)),
			subscribe(run, invalidate = noop) {
				const subscriber = [run, invalidate];
				subscribers.add(subscriber);
				if (subscribers.size === 1) stop = start(set, () => {}) || noop;
				run(value);
				return () => {
					subscribers.delete(subscriber);
					if (subscribers.size === 0 && stop) {
						stop();
						stop = null;
					}
				};
			}
		};
	};
}

const with_finally = make(true);
const without_finally = make(false);

function fan_out(writable, subscribers, sets) {
	const store = writable(0);
	let acc = 0;
	for (let i = 0; i < subscribers; i++) store.subscribe((v) => (acc += v));
	for (let i = 0; i < sets; i++) store.set(i);
	return acc;
}

function cascade(writable, depth, sets) {
	// each subscriber sets the next store, so the queue is genuinely exercised rather than bypassed
	const stores = [];
	for (let i = 0; i < depth; i++) stores.push(writable(0));
	let acc = 0;
	for (let i = 0; i < depth - 1; i++) stores[i].subscribe((v) => stores[i + 1].set(v));
	stores[depth - 1].subscribe((v) => (acc += v));
	for (let i = 0; i < sets; i++) stores[0].set(i);
	return acc;
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[s.length >> 1];
};

function compare(name, run, sets, rounds = 41) {
	// steady state first: both paths jitted before anything is recorded
	for (let i = 0; i < 20; i++) {
		run(with_finally);
		run(without_finally);
	}

	const time = (impl) => {
		const t0 = process.hrtime.bigint();
		run(impl);
		return Number(process.hrtime.bigint() - t0) / sets;
	};

	const a = [];
	const b = [];
	for (let r = 0; r < rounds; r++) {
		// alternate order every round so drift and thermal effects cannot favour one side
		if (r % 2 === 0) {
			a.push(time(with_finally));
			b.push(time(without_finally));
		} else {
			b.push(time(without_finally));
			a.push(time(with_finally));
		}
	}

	// medians, not means: a single GC pause skews a mean badly
	const ma = median(a);
	const mb = median(b);
	console.log(
		name.padEnd(26),
		'finally:',
		ma.toFixed(2).padStart(6),
		'ns  plain:',
		mb.toFixed(2).padStart(6),
		'ns  delta:',
		((ma - mb >= 0 ? '+' : '') + (((ma - mb) / mb) * 100).toFixed(2) + '%').padStart(7),
		'(' + (ma - mb).toFixed(3) + ' ns/set)'
	);
}

console.log('ns per set() call, median of 41 alternating rounds. One flush per set.\n');
compare('1 subscriber, 200k sets', (w) => fan_out(w, 1, 200_000), 200_000);
compare('8 subscribers, 200k sets', (w) => fan_out(w, 8, 200_000), 200_000);
compare('cascade depth 5, 100k sets', (w) => cascade(w, 5, 100_000), 100_000);
