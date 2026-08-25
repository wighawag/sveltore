// Behaviour that is sveltore's own, i.e. deliberately NOT asserted against svelte in parity.test.ts.
// This file covers the cross-copy shared queue; the one intentional behavioural deviation from
// svelte lives in deviation-throwing-subscriber.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { writable } from '../src/index.js';
import * as svelte from 'svelte/store';

const QUEUE_KEY = Symbol.for('sveltore.subscriber_queue.v1');

describe('shared notification queue', () => {
	it('is published on globalThis under a versioned symbol', () => {
		expect(Array.isArray((globalThis as any)[QUEUE_KEY])).toBe(true);
	});

	it('is adopted rather than replaced by a second copy of the module', async () => {
		const existing = (globalThis as any)[QUEUE_KEY];
		// A fresh module registry stands in for a duplicate install / separate bundle in the same realm.
		vi.resetModules();
		// @ts-expect-error the `?copy=N` suffix is what makes vite return a fresh module instance; TS cannot resolve it
		const second = (await import('../src/index.js?copy=2')) as typeof import('../src/index.js');
		expect((globalThis as any)[QUEUE_KEY]).toBe(existing);
		// and the second copy is really wired to it: its stores still notify
		expect(second.get(second.writable(1))).toBe(1);
	});

	it('keeps ordering guarantees across two copies of the module', async () => {
		vi.resetModules();
		// @ts-expect-error see above: `?copy=N` is a vite runtime specifier, not a TS-resolvable one
		const other = (await import('../src/index.js?copy=3')) as typeof import('../src/index.js');
		// guard against the test going vacuous: this must really be a second instance
		expect(other.writable).not.toBe(writable);

		const mine = writable(0);
		const theirs = other.writable(0);
		const order: string[] = [];

		mine.subscribe((v) => {
			order.push(`mine-a:${v}`);
			theirs.set(v);
		});
		mine.subscribe((v) => order.push(`mine-b:${v}`));
		theirs.subscribe((v) => order.push(`theirs:${v}`));

		order.length = 0;
		mine.set(1);

		// The cross-copy set is queued, not re-entered: without a shared queue this would be
		// ['mine-a:1', 'theirs:1', 'mine-b:1'].
		expect(order).toEqual(['mine-a:1', 'mine-b:1', 'theirs:1']);
	});

	it('cannot share with svelte, whose queue is module-private (documented limitation)', () => {
		// This is the honest counter-example to the test above, and the reason the README tells a
		// svelte app that cares to alias sveltore -> svelte/store instead. Mixing the two
		// implementations re-enters, exactly as two unshared copies would.
		const mine = writable(0);
		const theirs = svelte.writable(0);
		const order: string[] = [];

		mine.subscribe((v) => {
			order.push(`mine-a:${v}`);
			theirs.set(v);
		});
		mine.subscribe((v) => order.push(`mine-b:${v}`));
		theirs.subscribe((v) => order.push(`theirs:${v}`));

		order.length = 0;
		mine.set(1);

		expect(order).toEqual(['mine-a:1', 'theirs:1', 'mine-b:1']);
	});
});
