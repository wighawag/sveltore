// Ported from svelte 5.25.12:
//   src/internal/shared/utils.js            (noop, run_all)
//   src/internal/client/reactivity/equality.js (safe_not_equal)
//   src/store/utils.js                      (subscribe_to_store)
//
// `subscribe_to_store` is svelte's version minus the `untrack(...)` wrapper, which only exists to
// silence svelte's own reactivity-mutation validation and has no meaning outside a svelte runtime.

import type { Readable } from './store.js';

/** A function that does nothing. Used as the default no-op callback. */
export function noop(): void {}

/** Returns its argument unchanged. */
export const identity = <T>(x: T): T => x;

/** Calls every function in `arr`, in order. */
export function run_all(arr: Array<() => void>): void {
	for (let i = 0; i < arr.length; i++) {
		arr[i]();
	}
}

/**
 * Svelte's dirty-check. Objects and functions are ALWAYS considered changed (they may have been
 * mutated in place), and `NaN` is considered equal to itself (unlike `===`).
 */
export function safe_not_equal(a: unknown, b: unknown): boolean {
	return a != a ? b == b : a !== b || (a !== null && typeof a === 'object') || typeof a === 'function';
}

/**
 * Subscribes to a store, tolerating `null`/`undefined` stores and RxJS-style observables (whose
 * `subscribe` returns a subscription object rather than an unsubscribe function).
 */
export function subscribe_to_store<T>(
	store: Readable<T> | null | undefined,
	run: (value: T) => void,
	invalidate?: (value?: T) => void
): () => void {
	if (store == null) {
		// @ts-expect-error the caller is responsible for the `undefined` case
		run(undefined);
		if (invalidate) invalidate(undefined);
		return noop;
	}

	// svelte stores take a private second argument
	const unsub = store.subscribe(run, invalidate as () => void);

	// Also support RxJS
	return (unsub as any).unsubscribe ? () => (unsub as any).unsubscribe() : unsub;
}
