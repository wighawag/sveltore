// Ported from svelte's src/store/shared/index.js, which is byte-identical from 5.25.12 through at
// least 5.56.10 (test/parity.test.ts pins this against whatever svelte version is installed).
// https://github.com/sveltejs/svelte/blob/svelte%405.25.12/packages/svelte/src/store/shared/index.js
//
// The public API here is a strict SUBSET of `svelte/store`, with identical signatures and
// semantics, so `sveltore` can always be aliased to `svelte/store` by a consumer that has svelte
// (see README). `toStore` / `fromStore` are deliberately absent: they bridge to svelte's runes and
// cannot exist without the svelte runtime.

import { noop, run_all, safe_not_equal, subscribe_to_store } from './internal.js';

/** Callback to inform of a value updates. */
export type Subscriber<T> = (value: T) => void;

/** Unsubscribes from value updates. */
export type Unsubscriber = () => void;

/** Callback to update a value. */
export type Updater<T> = (value: T) => T;

/**
 * Start and stop notification callbacks.
 * This function is called when the first subscriber subscribes.
 *
 * @param set Function that sets the value of the store.
 * @param update Function that sets the value of the store after passing the current value to the update function.
 * @returns Optionally, a cleanup function that is called when the last remaining subscriber unsubscribes.
 */
export type StartStopNotifier<T> = (set: (value: T) => void, update: (fn: Updater<T>) => void) => void | (() => void);

/** Readable interface for subscribing. */
export interface Readable<T> {
	/**
	 * Subscribe on value changes.
	 * @param run subscription callback
	 * @param invalidate cleanup callback
	 */
	subscribe(this: void, run: Subscriber<T>, invalidate?: () => void): Unsubscriber;
}

/** Writable interface for both updating and subscribing. */
export interface Writable<T> extends Readable<T> {
	/**
	 * Set value and inform subscribers.
	 * @param value to set
	 */
	set(this: void, value: T): void;

	/**
	 * Update value using callback and inform subscribers.
	 * @param updater callback
	 */
	update(this: void, updater: Updater<T>): void;
}

/** Pair of subscriber and invalidator. */
type SubscribeInvalidateTuple<T> = [Subscriber<T>, () => void];

/** One or more `Readable`s. */
export type Stores = Readable<any> | [Readable<any>, ...Array<Readable<any>>] | Array<Readable<any>>;

/** One or more values from `Readable` stores. */
export type StoresValues<T> =
	T extends Readable<infer U> ? U : { [K in keyof T]: T[K] extends Readable<infer U> ? U : never };

/**
 * The notification queue, which flattens synchronous cascading updates so subscribers never observe
 * an intermediate state (store A's subscriber setting store B does not re-enter; B's notifications
 * are appended to the in-flight flush instead).
 *
 * It is held on `globalThis` under a versioned `Symbol.for` key so that several copies of sveltore
 * in one realm (duplicate installs, separate bundles, micro-frontends) share ONE queue and keep
 * that ordering guarantee across the boundary. The key is versioned because the sharing contract is
 * the queue's layout (`[subscriber, value, subscriber, value, ...]`): a future incompatible layout
 * must use a new key, which degrades to per-copy queues rather than corrupting them.
 *
 * Note this cannot be shared with svelte's own queue: svelte's is module-private with no handle.
 */
const QUEUE_KEY = Symbol.for('sveltore.subscriber_queue.v1');
const global_object = globalThis as any as { [QUEUE_KEY]?: Array<SubscribeInvalidateTuple<any> | any> };
const subscriber_queue: Array<SubscribeInvalidateTuple<any> | any> =
	global_object[QUEUE_KEY] || (global_object[QUEUE_KEY] = []);

/**
 * Creates a `Readable` store that allows reading by subscription.
 *
 * @param value initial value
 * @param start start and stop notifications for subscriptions
 */
export function readable<T>(value?: T, start?: StartStopNotifier<T>): Readable<T> {
	return {
		subscribe: writable(value, start).subscribe
	};
}

/**
 * Create a `Writable` store that allows both updating and reading by subscription.
 *
 * @param value initial value
 * @param start start and stop notifications for subscriptions
 */
export function writable<T>(value?: T, start: StartStopNotifier<T> = noop): Writable<T> {
	let stop: Unsubscriber | null = null;

	const subscribers: Set<SubscribeInvalidateTuple<T>> = new Set();

	function set(new_value: T): void {
		if (safe_not_equal(value, new_value)) {
			value = new_value;
			if (stop) {
				// store is ready
				const run_queue = !subscriber_queue.length;
				for (const subscriber of subscribers) {
					subscriber[1]();
					subscriber_queue.push(subscriber, value);
				}
				if (run_queue) {
					// `finally` is a deliberate FIX over svelte, not a port artifact: svelte clears the
					// queue only on the happy path, so a subscriber that throws leaves the queue
					// permanently non-empty and every later `set` silently stops notifying. That failure
					// mode is worse here, where the queue may be shared between copies.
					// Specified in test/deviation-throwing-subscriber.test.ts; the cost of the `try` is
					// measured in bench/ (it no longer deoptimizes, and costs a few ns per set).
					try {
						for (let i = 0; i < subscriber_queue.length; i += 2) {
							subscriber_queue[i][0](subscriber_queue[i + 1]);
						}
					} finally {
						subscriber_queue.length = 0;
					}
				}
			}
		}
	}

	function update(fn: Updater<T>): void {
		set(fn(value as T));
	}

	function subscribe(run: Subscriber<T>, invalidate: () => void = noop): Unsubscriber {
		const subscriber: SubscribeInvalidateTuple<T> = [run, invalidate];
		subscribers.add(subscriber);
		if (subscribers.size === 1) {
			stop = start(set, update) || noop;
		}
		run(value as T);

		return () => {
			subscribers.delete(subscriber);
			if (subscribers.size === 0 && stop) {
				stop();
				stop = null;
			}
		};
	}

	return { set, update, subscribe };
}

/**
 * Derived value store by synchronizing one or more readable stores and
 * applying an aggregation function over its input values.
 *
 * @param stores - input stores
 * @param fn - function callback that aggregates the values
 * @param initial_value - when used asynchronously
 */
export function derived<S extends Stores, T>(
	stores: S,
	fn: (values: StoresValues<S>, set: (value: T) => void, update: (fn: Updater<T>) => void) => Unsubscriber | void,
	initial_value?: T
): Readable<T>;

/**
 * Derived value store by synchronizing one or more readable stores and
 * applying an aggregation function over its input values.
 *
 * @param stores - input stores
 * @param fn - function callback that aggregates the values
 * @param initial_value - initial value
 */
export function derived<S extends Stores, T>(
	stores: S,
	fn: (values: StoresValues<S>) => T,
	initial_value?: T
): Readable<T>;

export function derived<T>(stores: Stores, fn: Function, initial_value?: T): Readable<T> {
	const single = !Array.isArray(stores);
	const stores_array: Array<Readable<any>> = single ? [stores as Readable<any>] : (stores as Array<Readable<any>>);

	if (!stores_array.every(Boolean)) {
		throw new Error('derived() expects stores as input, got a falsy value');
	}

	const auto = fn.length < 2;

	return readable(initial_value, (set, update) => {
		let started = false;
		const values: any[] = [];

		let pending = 0;
		let cleanup = noop;

		const sync = () => {
			if (pending) {
				return;
			}
			cleanup();
			const result = fn(single ? values[0] : values, set, update);
			if (auto) {
				set(result as T);
			} else {
				cleanup = typeof result === 'function' ? (result as Unsubscriber) : noop;
			}
		};

		const unsubscribers = stores_array.map((store, i) =>
			subscribe_to_store(
				store,
				(value) => {
					values[i] = value;
					pending &= ~(1 << i);
					if (started) {
						sync();
					}
				},
				() => {
					pending |= 1 << i;
				}
			)
		);

		started = true;
		sync();

		return function stop() {
			run_all(unsubscribers);
			cleanup();
			// We need to set this to false because callbacks can still happen despite having unsubscribed:
			// Callbacks might already be placed in the queue which doesn't know it should no longer
			// invoke this derived store.
			started = false;
		};
	});
}

/**
 * Takes a store and returns a new one derived from the old one that is readable.
 *
 * @param store - store to make readonly
 */
export function readonly<T>(store: Readable<T>): Readable<T> {
	// The `bind` is not needed for stores from this package (their `subscribe` is a closure, typed
	// `this: void`), but it is kept for parity with svelte because `readonly` also accepts foreign
	// store-contract objects, including RxJS observables, whose `subscribe` IS `this`-dependent.
	const subscribe = store.subscribe as (this: Readable<T>, run: Subscriber<T>, invalidate?: () => void) => Unsubscriber;
	return {
		subscribe: subscribe.bind(store)
	};
}

/**
 * Get the current value from a store by subscribing and immediately unsubscribing.
 *
 * @param store readable
 */
export function get<T>(store: Readable<T>): T {
	let value: T | undefined;
	subscribe_to_store(store, (_) => (value = _))();
	return value as T;
}
