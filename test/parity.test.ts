// The contract this package sells is "behaves exactly like `svelte/store`", so the test suite runs
// the SAME assertions against both implementations. If svelte changes something, this goes red and
// tells us the port drifted. It is also what makes the documented `alias sveltore -> svelte/store`
// escape hatch trustworthy rather than a hope.

import { describe, expect, it, vi } from 'vitest';
import * as sveltore from '../src/index.js';
import * as svelte from 'svelte/store';

type Impl = Pick<typeof sveltore, 'readable' | 'writable' | 'derived' | 'readonly' | 'get'>;

const implementations: Array<[string, Impl]> = [
	['sveltore', sveltore],
	['svelte/store', svelte as unknown as Impl]
];

describe.each(implementations)('%s', (_name, { readable, writable, derived, readonly, get }) => {
	describe('writable', () => {
		it('delivers the current value immediately on subscribe', () => {
			const store = writable(1);
			const seen: number[] = [];
			store.subscribe((v) => seen.push(v));
			expect(seen).toEqual([1]);
		});

		it('notifies on set and update', () => {
			const store = writable(1);
			const seen: number[] = [];
			store.subscribe((v) => seen.push(v));
			store.set(2);
			store.update((v) => v + 1);
			expect(seen).toEqual([1, 2, 3]);
		});

		it('stops notifying after unsubscribe', () => {
			const store = writable(1);
			const seen: number[] = [];
			const unsub = store.subscribe((v) => seen.push(v));
			unsub();
			store.set(2);
			expect(seen).toEqual([1]);
		});

		it('does not notify when the value is an unchanged primitive', () => {
			const store = writable(1);
			const run = vi.fn();
			store.subscribe(run);
			store.set(1);
			expect(run).toHaveBeenCalledTimes(1);
		});

		it('always notifies for objects, which may have been mutated in place', () => {
			const value = { a: 1 };
			const store = writable(value);
			const run = vi.fn();
			store.subscribe(run);
			store.set(value);
			expect(run).toHaveBeenCalledTimes(2);
		});

		it('treats NaN as equal to itself', () => {
			const store = writable(NaN);
			const run = vi.fn();
			store.subscribe(run);
			store.set(NaN);
			expect(run).toHaveBeenCalledTimes(1);
		});

		it('calls start on first subscriber and stop on last unsubscribe', () => {
			const stop = vi.fn();
			const start = vi.fn(() => stop);
			const store = writable(0, start);

			expect(start).not.toHaveBeenCalled();
			const a = store.subscribe(() => {});
			const b = store.subscribe(() => {});
			expect(start).toHaveBeenCalledTimes(1);

			a();
			expect(stop).not.toHaveBeenCalled();
			b();
			expect(stop).toHaveBeenCalledTimes(1);
		});

		it('restarts after the store is fully unsubscribed and used again', () => {
			const start = vi.fn(() => () => {});
			const store = writable(0, start);
			store.subscribe(() => {})();
			store.subscribe(() => {})();
			expect(start).toHaveBeenCalledTimes(2);
		});

		// svelte 4 added the second `update` argument to the start notifier. This is the assertion
		// that the port is not still on the svelte 3 signature.
		it('passes both set and update to the start notifier', () => {
			const store = writable(0, (set, update) => {
				set(1);
				update((v) => v + 1);
			});
			expect(get(store)).toBe(2);
		});

		it('ignores set() before anyone subscribes but keeps the value', () => {
			const store = writable(0);
			store.set(5);
			expect(get(store)).toBe(5);
		});
	});

	describe('readable', () => {
		it('exposes only subscribe', () => {
			const store = readable(1);
			expect((store as any).set).toBeUndefined();
			expect((store as any).update).toBeUndefined();
		});

		it('is driven by its start notifier', () => {
			const store = readable(0, (set) => {
				set(42);
			});
			expect(get(store)).toBe(42);
		});
	});

	describe('derived', () => {
		it('derives from a single store', () => {
			const a = writable(1);
			const doubled = derived(a, ($a) => $a * 2);
			const seen: number[] = [];
			doubled.subscribe((v) => seen.push(v));
			a.set(3);
			expect(seen).toEqual([2, 6]);
		});

		it('derives from an array of stores', () => {
			const a = writable(1);
			const b = writable(2);
			const sum = derived([a, b], ([$a, $b]) => $a + $b);
			const seen: number[] = [];
			sum.subscribe((v) => seen.push(v));
			a.set(3);
			b.set(4);
			expect(seen).toEqual([3, 5, 7]);
		});

		it('collapses a synchronous set in the async form, so the initial value is never seen', () => {
			const a = writable(1);
			const doubled = derived(
				a,
				($a, set) => {
					set($a * 2);
				},
				-1
			);
			const seen: number[] = [];
			doubled.subscribe((v) => seen.push(v));
			expect(seen).toEqual([2]);
		});

		it('shows the initial value until an asynchronous set lands', async () => {
			const a = writable(1);
			const doubled = derived(
				a,
				($a, set) => {
					const timer = setTimeout(() => set($a * 2), 0);
					return () => clearTimeout(timer);
				},
				-1
			);
			const seen: number[] = [];
			doubled.subscribe((v) => seen.push(v));
			expect(seen).toEqual([-1]);
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(seen).toEqual([-1, 2]);
		});

		it('passes update to the async form', () => {
			const a = writable(10);
			const store = derived(
				a,
				($a, _set, update) => {
					update((v) => v + $a);
				},
				0
			);
			expect(get(store)).toBe(10);
		});

		it('runs the returned cleanup between recomputations and on stop', () => {
			const cleanup = vi.fn();
			const a = writable(1);
			const store = derived(
				a,
				($a, set) => {
					set($a);
					return cleanup;
				},
				0
			);
			const unsub = store.subscribe(() => {});
			expect(cleanup).toHaveBeenCalledTimes(0);
			a.set(2);
			expect(cleanup).toHaveBeenCalledTimes(1);
			unsub();
			expect(cleanup).toHaveBeenCalledTimes(2);
		});

		it('throws when given a falsy store', () => {
			expect(() => derived([writable(1), undefined as any], () => 0)).toThrow(/derived/);
		});

		it('does not emit intermediate values for a diamond dependency', () => {
			// a -> b, a -> c, (b, c) -> d. A naive implementation notifies d twice for one `a` change,
			// once with a stale half of the diamond. This is the property the subscriber queue exists
			// for, and the reason multiple copies of the queue matter.
			const a = writable(1);
			const b = derived(a, ($a) => $a * 2);
			const c = derived(a, ($a) => $a * 3);
			const d = derived([b, c], ([$b, $c]) => `${$b}/${$c}`);

			const seen: string[] = [];
			d.subscribe((v) => seen.push(v));
			a.set(2);

			expect(seen).toEqual(['2/3', '4/6']);
		});
	});

	describe('readonly', () => {
		it('reflects the source but hides set/update', () => {
			const source = writable(1);
			const view = readonly(source);
			expect((view as any).set).toBeUndefined();
			source.set(2);
			expect(get(view)).toBe(2);
		});
	});

	describe('get', () => {
		it('reads without leaving a subscription behind', () => {
			const stop = vi.fn();
			const store = writable(1, () => stop);
			expect(get(store)).toBe(1);
			expect(stop).toHaveBeenCalledTimes(1);
		});
	});

	describe('notification queue', () => {
		it('flattens a cascading set instead of re-entering', () => {
			// `first`'s subscriber sets `second` while `first` is mid-notification. Both subscribers of
			// `first` must see the change before `second`'s subscriber runs.
			const first = writable(0);
			const second = writable(0);
			const order: string[] = [];

			first.subscribe((v) => {
				order.push(`first-a:${v}`);
				second.set(v);
			});
			first.subscribe((v) => order.push(`first-b:${v}`));
			second.subscribe((v) => order.push(`second:${v}`));

			order.length = 0;
			first.set(1);

			expect(order).toEqual(['first-a:1', 'first-b:1', 'second:1']);
		});
	});
});
