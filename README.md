# racePromises

A utility that runs async tasks in parallel and returns the first one that succeeds — automatically retrying if something goes wrong.

## What is this?

When you call something slow — like an LLM API — things can go wrong in two ways:

1. **It fails** (network error, rate limit, bad response) → you want to **retry**
2. **It takes too long** → rather than cancelling and waiting, you want to **fire off another call in parallel** and just use whichever one comes back first

`racePromises` handles both. You give it a function that creates a promise (your API call), tell it how many attempts to allow and how long to wait before firing off the next one, and it takes care of the rest. The first successful result wins.

> **Important:** This pattern works best for **idempotent** operations (e.g. reads, LLM inference). For writes or operations with side effects, launching duplicate requests can cause problems.

---

## Installation

```sh
npm i @pico-brief/race-promises
```

---

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `generatePromise` | `() => Promise<T>` | Yes | A function that starts your async task and returns a promise. Called once per attempt. |
| `amount` | `number` | Yes | Maximum number of calls that will ever be started. Must be greater than 0. Set to `1` for a single attempt with no retries. |
| `waitTimeSeconds` | `number` | Yes | How long to wait (in **seconds**) after starting a call before firing the next one in parallel. Use `0` to launch all attempts simultaneously. |
| `shouldRetry` | `(e: any) => boolean` | No | Called when a promise rejects. Return `false` to stop all attempts immediately. Defaults to always `true`. |
| `onBackgroundError` | `(e: any) => void` | No | Called when a promise rejects *after* the function has already returned a result. Use this to avoid unhandled rejection warnings. See notes below. |

---

## How it works

```
Start call #1
│
├── Succeeds?  →  ✅ Return result
│
├── shouldRetry(e) === false?  →  🛑 Stop everything, throw RetryAbortedError
│
└── No result yet, and either waitTimeSeconds has elapsed
    OR all current attempts have already failed?
      │
      Start next call in parallel  (previous calls still running!)
      │
      └── Whoever resolves first wins
```

The next call starts as soon as *either* condition is met — whichever comes first. You don't always wait the full `waitTimeSeconds` if all current attempts have already failed.

**If every attempt fails**, throws an `AggregateError` — inspect `e.errors` for each individual rejection reason.

**If `shouldRetry` returns `false`**, throws a `RetryAbortedError` immediately — even if other attempts are still in-flight. The triggering error is attached as `.cause`.

---

## Usage

### Basic example

```typescript
import racePromises from './racePromises';

const result = await racePromises({
    generatePromise: () => callMyLLM(prompt),
    amount: 3,             // fire at most 3 calls total
    waitTimeSeconds: 5,    // if no result after 5s, start another call in parallel
});
```

### Launch all attempts simultaneously

```typescript
const result = await racePromises({
    generatePromise: () => callMyLLM(prompt),
    amount: 3,
    waitTimeSeconds: 0,    // fire all 3 at once, take whoever responds first
});
```

### Single attempt, no retries

```typescript
const result = await racePromises({
    generatePromise: () => callMyLLM(prompt),
    amount: 1,
    waitTimeSeconds: 10,   // waitTimeSeconds is irrelevant with amount: 1
});
// equivalent to just: await callMyLLM(prompt)
// but with consistent error handling via AggregateError on failure
```

### With a custom retry condition

Stop retrying on errors you know are unrecoverable, like auth failures:

```typescript
const result = await racePromises({
    generatePromise: () => callMyLLM(prompt),
    amount: 5,
    waitTimeSeconds: 10,
    shouldRetry: (e) => {
        if (e?.status === 401 || e?.status === 403) return false;
        return true;
    },
});
```

### Handling background rejections

Once `racePromises` returns a winner, other in-flight promises keep running. If they later reject, the runtime will surface unhandled rejection warnings. Use `onBackgroundError` to handle them:

```typescript
const result = await racePromises({
    generatePromise: () => callMyLLM(prompt),
    amount: 3,
    waitTimeSeconds: 5,
    onBackgroundError: (e) => {
        console.warn('A losing attempt failed after the winner was found:', e);
    },
});
```

### Handling all failures

```typescript
import racePromises, { RetryAbortedError } from './racePromises';

try {
    const result = await racePromises({
        generatePromise: () => callMyLLM(prompt),
        amount: 3,
        waitTimeSeconds: 5,
    });
} catch (e) {
    if (e instanceof RetryAbortedError) {
        // shouldRetry returned false — e.cause is the error that triggered it
        console.error('Gave up retrying due to:', e.cause);
    } else if (e instanceof AggregateError) {
        // every attempt failed — e.errors contains each individual rejection reason
        console.error('All attempts failed:', e.errors);
    }
}
```

---

## Important notes

### `shouldRetry` is called per rejection, not per round
If multiple attempts are in-flight and they all fail at the same time, `shouldRetry` is called once for each rejection. If you implement a failure budget inside `shouldRetry` (e.g. "give up after 3 failures"), it will drain once per individual rejection — not once per stagger interval. Account for this when setting your budget.

### If `shouldRetry` itself throws, its exception becomes `RetryAbortedError.cause`
If your `shouldRetry` function throws an exception, that exception — not the original rejection that triggered `shouldRetry` — is used as the `cause` on the `RetryAbortedError`. This is intentional: the thrown exception is treated as the meaningful signal. If you see an unexpected `.cause` while debugging, check whether `shouldRetry` may be throwing internally.

### Promises are never cancelled
`waitTimeSeconds` means "if I haven't heard back in X seconds, start another one alongside it" — not "cancel and retry". A slow call is never stopped. If you need cleanup (e.g. aborting in-flight HTTP requests), pass an `AbortSignal` into your `generatePromise` and abort it once you have a result.

### `onBackgroundError` fires for losing rejections only
If a slow promise eventually *succeeds* after the function has already returned a winner, it is silently ignored — `onBackgroundError` is not called. It only fires for promises that eventually *fail* after the winner is known.
