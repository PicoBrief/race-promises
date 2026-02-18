export class RetryAbortedError extends Error {
    public readonly cause: any;
    constructor(cause: any) {
        super('racePromises: shouldRetry() returned false. No further attempts will be made.');
        this.name = 'RetryAbortedError';
        this.cause = cause;
    }
}

/**
 * Runs an async task with staggered retries and parallel racing.
 *
 * Starts the first attempt immediately. If it doesn't resolve within
 * `waitTimeSeconds`, a second attempt is started in parallel — both remain
 * in-flight and the first to succeed wins. This repeats up to `amount` total
 * attempts. If an attempt fails, `shouldRetry` decides whether to keep going.
 *
 * This is useful for long-running or unreliable tasks (e.g. LLM calls) where
 * you want low latency on success and automatic recovery from failures, without
 * cancelling slow-but-potentially-valid in-flight requests.
 *
 * Throws `RetryAbortedError` if `shouldRetry` returns false.
 * Throws `AggregateError` if all attempts fail without triggering an abort.
 * The `AggregateError.errors` array contains each individual rejection reason.
 */
export default async function racePromises<T>(params: {
    generatePromise: () => Promise<T>;
    amount: number;
    waitTimeSeconds: number; // seconds before starting the next parallel attempt (0 = launch all simultaneously)
    shouldRetry?: (e: any) => boolean;
    onBackgroundError?: (e: any) => void; // called when a promise rejects after the function has already returned.
                                          // fires for any rejection from a losing attempt, including slow-but-eventually-
                                          // failing promises. Does NOT fire for late resolutions (silently ignored).
                                          // note: shouldRetry is called once per rejection across all parallel attempts —
                                          // if 3 in-flight calls all fail simultaneously, shouldRetry is called 3 times.
                                          // a failure budget implemented inside shouldRetry will drain once per rejection,
                                          // not once per stagger interval.
}): Promise<T> {
    const { generatePromise, amount, waitTimeSeconds, onBackgroundError } = params;
    const shouldRetry = params.shouldRetry ?? (() => true);

    if (amount <= 0) throw new Error('amount must be greater than 0');
    if (waitTimeSeconds < 0) throw new Error('waitTimeSeconds must be non-negative'); // 0 is valid: launch all simultaneously

    const promises: Promise<T>[] = [];

    // One-shot semaphore: notifyUpdate() wakes the next waitForUpdate() call.
    // pendingUpdate handles the case where notifyUpdate() fires before waitForUpdate()
    // has been called — without it, that wakeup would be lost and the loop would sleep
    // until the deadline unnecessarily.
    let pendingUpdate = false;
    let resolveUpdate: (() => void) | null = null;

    function notifyUpdate() {
        if (resolveUpdate) { resolveUpdate(); resolveUpdate = null; }
        else pendingUpdate = true;
    }
    function waitForUpdate() {
        if (pendingUpdate) { pendingUpdate = false; return Promise.resolve(); }
        return new Promise<void>(res => { resolveUpdate = res; });
    }

    let hasSucceeded = false;
    let successValue: T;
    let failureCount = 0;
    let rejections: any[] = []; // collected for AggregateError if all attempts fail
    let keepRetrying = true;
    let abortCause: any;
    let isSettled = false; // true once the function has returned a result

    function handleError(e: any) {
        // First non-retryable error wins; subsequent ones are intentionally ignored since
        // we've already decided to stop — the first abort signal is what matters.
        if (keepRetrying) {
            try {
                if (!shouldRetry(e)) {
                    keepRetrying = false;
                    abortCause = e;
                }
            } catch (shouldRetryException) {
                // shouldRetry itself threw — use that exception as the cause, not the original
                // error, since the exception from shouldRetry is the meaningful signal here.
                keepRetrying = false;
                abortCause = shouldRetryException;
            }
        }
    }

    function trackPromise(p: Promise<T>): Promise<T> {
        p.then((value) => {
            if (!hasSucceeded) successValue = value; // only capture the first winner
            hasSucceeded = true;
            notifyUpdate();
        }).catch((e) => {
            failureCount++;
            rejections.push(e);
            if (isSettled) {
                onBackgroundError?.(e);
                return;
            }
            handleError(e);
            notifyUpdate();
        });
        return p;
    }

    function launchAttempt(): void {
        try {
            promises.push(trackPromise(generatePromise()));
        } catch (e) {
            // generatePromise threw synchronously — route through trackPromise so that
            // all counter increments, rejection collection, handleError, and notifyUpdate
            // are handled consistently with the async failure path.
            promises.push(trackPromise(Promise.reject(e) as Promise<T>));
        }
    }

    for (let i = 0; i < amount; i++) {
        launchAttempt();

        const deadline = Date.now() + waitTimeSeconds * 1000;
        // deadlineSleep is created once and reused across inner loop iterations.
        // This is intentional: a resolved promise stays resolved, so once the deadline
        // fires it will keep winning the race and the while condition will end the loop.
        // When waitTimeSeconds is 0, deadline === Date.now() so this loop never executes —
        // success/failure is caught by the post-loop checks below.
        const deadlineSleep = sleepAsync(waitTimeSeconds * 1000);
        while (Date.now() < deadline) {
            await Promise.race([waitForUpdate(), deadlineSleep]);
            if (hasSucceeded) { isSettled = true; return successValue!; }
            if (!keepRetrying) { isSettled = true; throw new RetryAbortedError(abortCause); }
            if (failureCount === i + 1) break; // all attempts so far failed — start the next one early
        }

        if (hasSucceeded) { isSettled = true; return successValue!; }
        if (!keepRetrying) { isSettled = true; throw new RetryAbortedError(abortCause); }
    }

    if (!keepRetrying) { isSettled = true; throw new RetryAbortedError(abortCause); }

    // If every promise has already failed, throw explicitly rather than letting Promise.any
    // throw an AggregateError opaquely — keeps the error contract consistent and deliberate.
    if (failureCount === promises.length) {
        isSettled = true;
        throw new AggregateError(rejections, 'racePromises: all attempts failed.');
    }

    // Some promises are still in-flight. We await rather than returning the promise directly
    // so that isSettled = true is only set after a winner is known — ensuring any rejections
    // that arrive after that point are correctly routed to onBackgroundError.
    // If Promise.any rejects (all in-flight promises ultimately fail), apply our own error
    // contract: RetryAbortedError if shouldRetry fired, otherwise our custom AggregateError.
    // This also covers waitTimeSeconds=0, where all attempts launch synchronously before any
    // .catch() handlers run, so the pre-loop explicit checks above are never reached.
    try {
        const winner = await Promise.any(promises);
        isSettled = true;
        return winner;
    } catch (_) {
        isSettled = true;
        if (!keepRetrying) throw new RetryAbortedError(abortCause);
        throw new AggregateError(rejections, 'racePromises: all attempts failed.');
    }
}

// exported for convenience — consider moving to a shared utilities module if you use it elsewhere
export const sleepAsync = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
