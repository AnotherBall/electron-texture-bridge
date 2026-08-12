---
name: chaining-neverthrow-results
description: Use when composing or chaining neverthrow Result / ResultAsync values — sequencing multi-step operations where each step can fail, recovering from a specific error, or deciding where to turn a Result into a plain value or HTTP response. Also when reaching for .match mid-pipeline, .match inside a value-producing private method, _unsafeUnwrap, isErr()+.value unwrapping, safeTry / yield*, or a try/catch around Result-returning code.
---

# Chaining neverthrow Results

## Overview

Once a value is a `Result`/`ResultAsync`, **keep it one.** Compose every step with combinators (`.andThen / .map / .mapErr / .orElse / .andTee`) and call `.match` exactly once, at the consumption edge, to turn the chain into the outside-world value (HTTP response, CLI exit, rendered output). The error channel stays a typed union the whole way; `.match` is where — and the only place where — it collapses.

This generalizes the route-boundary rule. **RELATED:** `backend-typescript-roadmap` owns the route specifics (`ApplicationError` union, `err.statusCode satisfies ContentfulStatusCode`); `precise-type-modeling` owns the error union itself.

## The combinators (the whole vocabulary)

| Combinator | Use for |
|---|---|
| `.andThen(fn)` | Next step that can itself fail (returns a `Result`/`ResultAsync`). Short-circuits on error. |
| `.map(fn)` | Transform the success value (cannot fail). |
| `.mapErr(fn)` | Normalize the error — e.g. into the shared `ApplicationError` union so the final `.match` is exhaustive. |
| `.orElse(fn)` | **Recover** from an error: return `okAsync(fallback)` for the case you handle, `errAsync(e)` to re-propagate the rest. |
| `.andTee(fn)` | Fire a side-effect (notify, log) without changing the value. |
| `.orTee(fn)` | Fire a side-effect on the **error** side (release a handle, log) — the `Err` passes through unchanged, synchronously. Not for recovery; that is `.orElse`. |
| `.asyncAndThen(fn)` | Bridge a **sync** `Result` into an async chain (the first async step). |
| `fromPromise(p, e => new XError(...))` | Bring a throwing promise into the chain — the one place a throw is caught. |
| `Result.fromThrowable(fn, e => new XError(...))` | Bring a throwing **sync** function into the chain. **Bind it once to a named const** — `const safeFn = Result.fromThrowable(fn, wrap)` (arguments are forwarded), module scope when `fn` takes its dependencies as arguments, a local const otherwise. Never call it inline as `Result.fromThrowable(...)()` — that is the banned IIFE shape (see functional-programming rules). |

## The recipe

```ts
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

// Each step returns a Result / ResultAsync. Build ONE chain; never unwrap mid-flow.
function run(raw: unknown): ResultAsync<Done, AppError> {
  return parse(raw) // Result<Input, AppError>
    .asyncAndThen((input) => load(input.id).map((record) => ({ input, record }))) // sync → async
    .andThen(({ input, record }) =>
      act(record, input).orElse((e) =>
        e.code === "recoverable" ? okAsync(fallback) : errAsync(e), // recover one case, re-propagate the rest
      ),
    )
    .andTee(() => notify()) // side-effect, value untouched
    .andThen((done) => save(done).map(() => done)); // thread `done` past a void step
}
```

Consume once, at the edge — the only `.match`:

```ts
function handle(raw: unknown): Promise<Response> {
  return run(raw).match(
    (done) => ({ status: 200, body: done }),
    (err) => ({ status: err.statusCode, body: { error: err.error } }),
  );
}
```

## Where the edge is

`.match` belongs only where the Result leaves your code for the outside world: the Hono route handler, a CLI `main`, a top-level effect, or a test assertion (tests may also use `isOk()/isErr()`). Service/domain/helper layers return the `ResultAsync` onward — they never `.match`.

## Inside a class: producers return, the driver consumes

The same edge rule applies *within* a class (owner ruling, 2026-08-12). A value-producing private method is a **producer**: it returns the `Result`/`ResultAsync` as-is. Consumption happens only in the **driver** — the tick loop, the public void method, the event boundary — where errors become their final vocabulary (an `"error"` event, a counter, a response).

Two corollaries:

- **No failure variants in the ok channel.** If the error channel carries the failures, an ok value like `"delivered" | "skipped" | "failed"` is a smell — `"failed"` is dead weight duplicating the `Err` side. Narrow the ok union and let the driver's `.match` err branch do the failure bookkeeping. (This also deletes the double-emit hazards that count-only helper methods exist to work around.)
- **`await` is not consumption.** Awaiting a `ResultAsync` yields a `Result` — a pass-through layer that only manages a flag may `await` and return the `Result` untouched:

```ts
// ❌ producer consumes: caller loses the typed error, "failed" leaks into ok
private async _send(frame: Frame): Promise<"delivered" | "skipped" | "failed"> {
  return this._prepare(frame).asyncAndThen((i) => this._deliver(i)).match(
    (r) => r,
    (e) => { this.emit("error", e); return "failed" as const; },
  );
}

// ✅ producer returns; the driver (_tick) owns the single .match
private _send(frame: Frame): ResultAsync<"delivered" | "skipped", PrepareError | DeliverError> {
  return this._prepare(frame).asyncAndThen((imported) => this._deliver(imported));
}

private async _sendTracked(frame: Frame) {   // pass-through: await ≠ consumption
  this._inFlight = true;
  try {
    return await this._send(frame);
  } finally {
    this._inFlight = false;
  }
}

private async _tick(): Promise<void> {       // the driver — the only .match
  const sent = await this._sendTracked(frame);
  sent.match(
    (result) => this._handleOutcome(result),
    (error) => { this.emit("error", error); this._countTickError(); },
  );
}
```

A sync `Result` matched in the driver keeps same-tick timing (e.g. a circuit breaker); only genuinely async stages defer by a microtask.

## Anti-patterns

| Instead of | Do |
|---|---|
| `.match` mid-pipeline to branch then re-wrap in `ok`/`err` | `.andThen` (success path) / `.orElse` (recovery) |
| `.match` inside a value-producing private method | Return the `Result`; the driver (tick loop / public void method / event boundary) holds the only `.match` |
| `.orElse((e) => { sideEffect(); return err(e); })` — tap then re-wrap | `.orTee(sideEffect)` — `Err` passthrough is implicit; keep `.orElse` for conditional recovery only |
| A `"failed"`-style variant in the ok channel mirroring the error channel | Narrow the ok union; failures ride the `Err` side to the driver's `.match` |
| Recovering via `match(ok, err => …)` then `okAsync(...)` | `.orElse((e) => handled ? okAsync(x) : errAsync(e))` |
| `_unsafeUnwrap()` / `_unsafeUnwrapErr()` in production code | Carry the `Result`; collapse only at the edge with `.match` |
| `if (r.isErr()) return …; const v = r.value` mid-flow | `.andThen` (`isErr`/`.value` is for tests, not production flow) |
| `try { … } catch` around a Result-returning call | `fromPromise(p, e => new XError(...))`, then chain |
| `Result.fromThrowable(() => x.y(), wrap)()` — wrap-and-invoke inline (IIFE shape) | `const safeY = Result.fromThrowable((x) => x.y(), wrap);` once at module scope, then `safeY(x)` in the chain |
| `safeTry` + `yield*` generator do-notation | Chain with `.andThen` / `.orElse` — this is the project's style |

## Red Flags — STOP

- About to write `.match` somewhere that is not the consumption edge → use `.andThen`/`.orElse`.
- About to write `_unsafeUnwrap` / `_unsafeUnwrapErr` outside a test.
- About to `await` a Result and read `.value` / `.error` outside a test → keep chaining.
- About to `import { safeTry }` or `yield*` a Result → use combinators.
- A `try/catch` wrapping code that already returns a Result → wrap the throwing promise once with `fromPromise`.
- About to write `)()` right after `Result.fromThrowable(...)` → bind it to a named const first; forward arguments instead of closing over them.
- About to `.match` inside a private method that returns a value → return the `Result`/`ResultAsync`; consume in the driver.
- About to write an ok variant named like a failure (`"failed"`, `"errored"`) → the error channel already carries it; narrow the ok union.
- About to `.orElse` only to run a side-effect and `return err(e)` → `.orTee`.
