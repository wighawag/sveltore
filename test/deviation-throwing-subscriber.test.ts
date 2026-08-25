// sveltore is a faithful port of `svelte/store` with exactly ONE intentional behavioural
// difference, and this file is its specification. Both sides are asserted: what svelte does, and
// what sveltore does instead. Read it as the rationale for the `finally` in `src/store.ts`.
//
// Svelte's `set` empties the notification queue only on the happy path:
//
//     if (run_queue) {
//         for (let i = 0; i < subscriber_queue.length; i += 2) {
//             subscriber_queue[i][0](subscriber_queue[i + 1]);
//         }
//         subscriber_queue.length = 0;   // <- never reached if a subscriber throws
//     }
//
// A subscriber that throws therefore leaves the module-level queue permanently non-empty. Every
// later `set` in that module instance sees a non-empty queue, concludes another flush already owns
// it, appends and returns. Nothing ever drains it again, so the whole store system goes silent with
// no error and no way back. sveltore puts the reset in a `finally`.
//
// The obvious objection is that svelte omits the `finally` for performance. `bench/` measures that
// claim: on node 22 both forms report the identical V8 optimization status, and the cost is low
// single-digit nanoseconds per set, with noise of the same magnitude.
//
// This file is deliberately separate so that wedging svelte's queue (which is irreversible, by
// definition) is contained: vitest isolates module registries per file, so parity.test.ts still
// gets a healthy svelte.

import { describe, expect, it } from 'vitest';
import * as sveltore from '../src/index.js';
import * as svelte from 'svelte/store';

const QUEUE_KEY = Symbol.for('sveltore.subscriber_queue.v1');

/**
 * Makes a store whose subscriber throws on a given value, trips it, and then reports whether an
 * unrelated store in the same module instance can still notify afterwards.
 */
function survives_a_throwing_subscriber(impl: Pick<typeof sveltore, 'writable'>): boolean {
	const exploding = impl.writable(0);
	exploding.subscribe((v) => {
		if (v === 1) throw new Error('boom');
	});
	expect(() => exploding.set(1)).toThrow('boom');

	const seen: string[] = [];
	const unrelated = impl.writable('a');
	unrelated.subscribe((v) => seen.push(v));
	unrelated.set('b');

	return seen.join(',') === 'a,b';
}

describe('a subscriber that throws during a flush', () => {
	it('leaves sveltore fully usable', () => {
		expect(survives_a_throwing_subscriber(sveltore)).toBe(true);
	});

	it('leaves the sveltore queue empty rather than owned by a flush that never finished', () => {
		// The mechanism, not just the symptom. This is what the `finally` guarantees, and it matters
		// more here than upstream because the queue is shared between copies of sveltore: a wedge in
		// one copy would otherwise silence every other copy in the realm too.
		const store = sveltore.writable(0);
		store.subscribe((v) => {
			if (v === 1) throw new Error('boom');
		});
		expect(() => store.set(1)).toThrow('boom');
		expect((globalThis as any)[QUEUE_KEY]).toHaveLength(0);
	});

	it('drops the rest of the interrupted batch, as svelte would have', () => {
		// The deviation restores the ability to notify LATER; it does not resurrect the batch that was
		// in flight when the error was thrown. A subscriber queued behind the thrower does not run.
		const store = sveltore.writable(0);
		const after: number[] = [];
		store.subscribe((v) => {
			if (v === 1) throw new Error('boom');
		});
		store.subscribe((v) => after.push(v));

		after.length = 0;
		expect(() => store.set(1)).toThrow('boom');
		expect(after).toEqual([]);

		// but the store is not dead: it notifies again on the next set
		expect(() => store.set(2)).not.toThrow();
		expect(after).toEqual([2]);
	});

	// Characterisation test for the upstream behaviour this deviates from. If svelte ever fixes it,
	// this goes red, which is the signal that the deviation is obsolete and sveltore can drop it and
	// go back to being a byte-for-byte port.
	it('wedges svelte/store permanently (upstream behaviour, kept honest here)', () => {
		expect(survives_a_throwing_subscriber(svelte)).toBe(false);
	});
});
