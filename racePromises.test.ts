import { test } from 'node:test';
import assert from 'node:assert/strict';
import racePromises, { RetryAbortedError, sleepAsync } from './racePromises.ts';

// --- Helpers ---

const ok = <T>(value: T) => () => Promise.resolve(value);
const fail = (err: unknown) => () => Promise.reject(err);
const slow = <T>(value: T, ms: number) => () => sleepAsync(ms).then(() => value);
const slowFail = (err: unknown, ms: number) => () => sleepAsync(ms).then(() => Promise.reject(err));

// --- Input validation ---

test('throws if amount is 0', async () => {
    await assert.rejects(
        () => racePromises({ generatePromise: ok(1), amount: 0, waitTimeSeconds: 1 }),
        { message: 'amount must be greater than 0' }
    );
});

test('throws if amount is negative', async () => {
    await assert.rejects(
        () => racePromises({ generatePromise: ok(1), amount: -1, waitTimeSeconds: 1 }),
        { message: 'amount must be greater than 0' }
    );
});

test('throws if waitTimeSeconds is negative', async () => {
    await assert.rejects(
        () => racePromises({ generatePromise: ok(1), amount: 1, waitTimeSeconds: -1 }),
        { message: 'waitTimeSeconds must be non-negative' }
    );
});

// --- Basic success ---

test('resolves with the value of a single successful attempt', async () => {
    const result = await racePromises({ generatePromise: ok(42), amount: 1, waitTimeSeconds: 10 });
    assert.equal(result, 42);
});

test('returns the correct value, not just a truthy one', async () => {
    const result = await racePromises({ generatePromise: ok(0), amount: 3, waitTimeSeconds: 0 });
    assert.equal(result, 0);
});

// --- All attempts fail ---

test('throws AggregateError when all attempts fail', async () => {
    const errors = [new Error('e1'), new Error('e2'), new Error('e3')];
    let i = 0;
    const err = await racePromises({
        generatePromise: () => Promise.reject(errors[i++]),
        amount: 3,
        waitTimeSeconds: 0,
    }).then(() => null, e => e);
    assert.ok(err instanceof AggregateError, `Expected AggregateError, got ${err}`);
    assert.equal(err.message, 'racePromises: all attempts failed.');
    assert.deepEqual(err.errors, errors);
});

// --- shouldRetry ---

test('throws RetryAbortedError when shouldRetry returns false', async () => {
    const cause = new Error('fatal');
    const err = await racePromises({
        generatePromise: fail(cause),
        amount: 5,
        waitTimeSeconds: 0,
        shouldRetry: () => false,
    }).then(() => null, e => e);
    assert.ok(err instanceof RetryAbortedError, `Expected RetryAbortedError, got ${err}`);
    assert.equal(err.cause, cause);
});

test('RetryAbortedError.cause is the exception thrown by shouldRetry, not the original error', async () => {
    const retryException = new Error('shouldRetry exploded');
    const err = await racePromises({
        generatePromise: fail(new Error('original')),
        amount: 3,
        waitTimeSeconds: 0,
        shouldRetry: () => { throw retryException; },
    }).then(() => null, e => e);
    assert.ok(err instanceof RetryAbortedError);
    assert.equal(err.cause, retryException);
});

test('stops all attempts when shouldRetry returns false, even with remaining budget', async () => {
    // waitTimeSeconds: 0 launches all attempts simultaneously before any rejection fires,
    // so use a small nonzero stagger to allow shouldRetry to abort between launches.
    let calls = 0;
    await racePromises({
        generatePromise: () => { calls++; return Promise.reject(new Error('fail')); },
        amount: 10,
        waitTimeSeconds: 0.01,
        shouldRetry: () => false,
    }).catch(() => {});
    assert.equal(calls, 1);
});

// --- Retry behaviour ---

test('retries after a failure and returns the successful result', async () => {
    let calls = 0;
    const result = await racePromises({
        generatePromise: () => {
            calls++;
            return calls === 1 ? Promise.reject(new Error('first fail')) : Promise.resolve('ok');
        },
        amount: 2,
        waitTimeSeconds: 0,
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
});

test('starts the next attempt immediately if all current attempts have already failed (no waiting for stagger)', async () => {
    // waitTimeSeconds is 1s, but the first attempt fails instantly — the second
    // should start right away rather than waiting out the full second.
    const start = Date.now();
    let calls = 0;
    const result = await racePromises({
        generatePromise: () => {
            calls++;
            return calls === 1 ? Promise.reject(new Error('instant fail')) : Promise.resolve('fast');
        },
        amount: 2,
        waitTimeSeconds: 1,
    });
    assert.equal(result, 'fast');
    assert.ok(Date.now() - start < 500, 'Should not have waited out the full stagger delay');
});

// --- Parallel racing ---

test('starts a second attempt after waitTimeSeconds when the first is still pending', async () => {
    let calls = 0;
    const result = await racePromises({
        generatePromise: () => {
            calls++;
            // First call never resolves; second resolves immediately
            return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('second wins');
        },
        amount: 2,
        waitTimeSeconds: 0.02, // 20ms
    });
    assert.equal(result, 'second wins');
    assert.equal(calls, 2);
});

test('with waitTimeSeconds=0 launches all attempts simultaneously and returns the first to resolve', async () => {
    // Attempts resolve after 30ms, 10ms, 20ms respectively — the 10ms one should win.
    const resolvedValues: string[] = [];
    const result = await racePromises({
        generatePromise: (() => {
            const delays = [30, 10, 20];
            let i = 0;
            return () => slow(`attempt-${i}`, delays[i++])();
        })(),
        amount: 3,
        waitTimeSeconds: 0,
    });
    assert.equal(result, 'attempt-1');
    void resolvedValues; // collected via side-effect in a real scenario
});

// --- onBackgroundError ---

test('calls onBackgroundError when an in-flight promise rejects after a winner is found', async () => {
    const backgroundErrors: unknown[] = [];
    const lateError = new Error('late failure');

    // Control p1 manually so it fails after racePromises returns
    let rejectP1!: (e: unknown) => void;
    const p1 = new Promise<string>((_, rej) => { rejectP1 = rej; });

    let call = 0;
    const result = await racePromises({
        generatePromise: () => {
            call++;
            return call === 1 ? p1 : Promise.resolve('winner');
        },
        amount: 2,
        waitTimeSeconds: 0,
        onBackgroundError: e => backgroundErrors.push(e),
    });

    assert.equal(result, 'winner');
    assert.deepEqual(backgroundErrors, []); // not fired yet

    rejectP1(lateError);
    await sleepAsync(20); // let microtasks settle

    assert.deepEqual(backgroundErrors, [lateError]);
});

test('does not call onBackgroundError for a late resolution (only for rejections)', async () => {
    const backgroundErrors: unknown[] = [];

    let resolveP1!: (v: string) => void;
    const p1 = new Promise<string>(res => { resolveP1 = res; });

    let call = 0;
    const result = await racePromises({
        generatePromise: () => {
            call++;
            return call === 1 ? p1 : Promise.resolve('winner');
        },
        amount: 2,
        waitTimeSeconds: 0,
        onBackgroundError: e => backgroundErrors.push(e),
    });

    assert.equal(result, 'winner');
    resolveP1('late success'); // silent — should not trigger onBackgroundError
    await sleepAsync(20);
    assert.deepEqual(backgroundErrors, []);
});

// --- Synchronous throws from generatePromise ---

test('handles a synchronous throw from generatePromise as a rejection', async () => {
    const syncError = new Error('sync throw');
    let calls = 0;
    const err = await racePromises({
        generatePromise: () => { calls++; throw syncError; },
        amount: 2,
        waitTimeSeconds: 0,
    }).then(() => null, e => e);
    assert.ok(err instanceof AggregateError);
    assert.deepEqual(err.errors, [syncError, syncError]);
    assert.equal(calls, 2);
});

// --- RetryAbortedError shape ---

test('RetryAbortedError has the correct name and message', async () => {
    const err = await racePromises({
        generatePromise: fail(new Error('boom')),
        amount: 1,
        waitTimeSeconds: 0,
        shouldRetry: () => false,
    }).then(() => null, e => e);
    assert.ok(err instanceof RetryAbortedError);
    assert.equal(err.name, 'RetryAbortedError');
    assert.equal(err.message, 'racePromises: shouldRetry() returned false. No further attempts will be made.');
});

// --- shouldRetry argument ---

test('shouldRetry is called with the rejection value as its argument', async () => {
    const cause = new Error('specific error');
    let received: unknown;
    await racePromises({
        generatePromise: fail(cause),
        amount: 1,
        waitTimeSeconds: 0,
        shouldRetry: (e) => { received = e; return false; },
    }).catch(() => {});
    assert.equal(received, cause);
});

// --- AggregateError with a single failure ---

test('AggregateError.errors contains a single entry when amount=1 fails', async () => {
    const cause = new Error('only error');
    const err = await racePromises({
        generatePromise: fail(cause),
        amount: 1,
        waitTimeSeconds: 0,
    }).then(() => null, e => e);
    assert.ok(err instanceof AggregateError);
    assert.deepEqual(err.errors, [cause]);
});

// --- generatePromise call count ---

test('generatePromise is called exactly amount times when all attempts fail', async () => {
    let calls = 0;
    const err = await racePromises({
        generatePromise: () => { calls++; return Promise.reject(new Error('fail')); },
        amount: 3,
        waitTimeSeconds: 0,
    }).then(() => null, e => e);
    assert.ok(err instanceof AggregateError);
    assert.equal(calls, 3);
});

// --- Fast first success prevents further attempts ---

test('does not launch additional attempts if the first resolves before the stagger interval', async () => {
    let calls = 0;
    await racePromises({
        generatePromise: () => { calls++; return Promise.resolve('fast'); },
        amount: 3,
        waitTimeSeconds: 1,
    });
    assert.equal(calls, 1);
});

// --- Multiple background errors ---

test('calls onBackgroundError for each in-flight rejection that arrives after the winner resolves', async () => {
    const backgroundErrors: unknown[] = [];
    const err1 = new Error('bg1');
    const err2 = new Error('bg2');

    let rejectP1!: (e: unknown) => void;
    let rejectP2!: (e: unknown) => void;
    const p1 = new Promise<string>((_, rej) => { rejectP1 = rej; });
    const p2 = new Promise<string>((_, rej) => { rejectP2 = rej; });

    let call = 0;
    const result = await racePromises({
        generatePromise: () => {
            call++;
            if (call === 1) return p1;
            if (call === 2) return p2;
            return Promise.resolve('winner');
        },
        amount: 3,
        waitTimeSeconds: 0,
        onBackgroundError: e => backgroundErrors.push(e),
    });

    assert.equal(result, 'winner');
    rejectP1(err1);
    rejectP2(err2);
    await sleepAsync(20);

    assert.deepEqual(backgroundErrors, [err1, err2]);
});

// --- Background rejection does not invoke shouldRetry ---

test('shouldRetry is not called for background rejections after the function has already settled', async () => {
    let shouldRetryCalls = 0;

    let rejectLate!: (e: unknown) => void;
    const latePromise = new Promise<string>((_, rej) => { rejectLate = rej; });

    let call = 0;
    await racePromises({
        generatePromise: () => {
            call++;
            return call === 1 ? latePromise : Promise.resolve('winner');
        },
        amount: 2,
        waitTimeSeconds: 0,
        shouldRetry: () => { shouldRetryCalls++; return true; },
    });

    rejectLate(new Error('late'));
    await sleepAsync(20);

    assert.equal(shouldRetryCalls, 0);
});
