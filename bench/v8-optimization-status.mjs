// Companion to finally-overhead.mjs, answering the harder version of the same objection: it is not
// just that `try` might be slow, it is that under V8's old Crankshaft compiler a function
// containing `try` was NEVER optimized at all. If that were still true, the `finally` in
// src/store.ts would deoptimize the entire flush path, which no microbenchmark of a warm loop would
// necessarily reveal.
//
// It is not still true. Run:
//
//     node --allow-natives-syntax bench/v8-optimization-status.mjs
//
// Measured on node 22 (2025): both functions report the identical status, TurboFanned included.

function flush_with_finally(queue, sink) {
	try {
		for (let i = 0; i < queue.length; i += 2) sink(queue[i]);
	} finally {
		queue.length = 0;
	}
}

function flush_plain(queue, sink) {
	for (let i = 0; i < queue.length; i += 2) sink(queue[i]);
	queue.length = 0;
}

let acc = 0;
const sink = (v) => (acc += v);
const fill = () => {
	const q = [];
	for (let i = 0; i < 64; i++) q.push(i, i);
	return q;
};

for (let i = 0; i < 200_000; i++) {
	flush_with_finally(fill(), sink);
	flush_plain(fill(), sink);
}

%OptimizeFunctionOnNextCall(flush_with_finally);
%OptimizeFunctionOnNextCall(flush_plain);
flush_with_finally(fill(), sink);
flush_plain(fill(), sink);

// bit layout from v8/src/runtime/runtime-test.cc
const BITS = {
	IsFunction: 1 << 0,
	NeverOptimize: 1 << 1,
	AlwaysOptimize: 1 << 2,
	MaybeDeopted: 1 << 3,
	Optimized: 1 << 4,
	Maglevved: 1 << 5,
	TurboFanned: 1 << 6,
	Interpreted: 1 << 7,
	MarkedForOptimization: 1 << 8
};

function show(fn, name) {
	const status = %GetOptimizationStatus(fn);
	const flags = Object.entries(BITS)
		.filter(([, mask]) => status & mask)
		.map(([label]) => label)
		.join(', ');
	console.log(name.padEnd(14), 'status=' + String(status).padStart(4), '=>', flags);
}

show(flush_with_finally, 'with finally');
show(flush_plain, 'plain');
