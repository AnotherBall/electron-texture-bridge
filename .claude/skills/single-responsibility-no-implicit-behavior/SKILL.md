---
name: single-responsibility-no-implicit-behavior
description: Use when designing or reviewing a function — specifically when a function named for one responsibility (register, add, create, consume) also performs a hidden side effect like lazy init, setup on first call, or background resource installation
---

# Single Responsibility: No Implicit Behavior

## Overview

A function does exactly one advertised thing. It does NOT perform additional side effects that the name and signature do not imply — not even "just once" lazy initialization, not even "for convenience" automatic setup.

**Core principle:** If the function's name says "register X", it must not also "install Y on first call". Split into two functions, each with one responsibility.

## When to Apply

**Symptoms of violation:**
- A function has an `installed` / `initialized` / `_first` flag gating a branch
- A function named `doX` also calls `setupY()` when Y is not yet set up
- Documentation says "on the first call, also ..."
- Tests assert "installs X on first register" — the fact that this is observable means the behavior is real and should be named
- Callers describe the function's behavior with "and also" ("registers a handler AND installs the receiver")
- A module-level `let initialized = false` flag exists alongside feature methods

**Not a violation:**
- Pure helpers (input → output, no side effects)
- Side effects the name advertises directly (`start`, `install`, `connect`, `open`)
- Cleanup in `finally` for resources the function itself acquired (lifecycle symmetry)

## The Fix

Split the hidden init out into an explicit, idempotent setup function. Export both.

```typescript
// ❌ Violation — consumeSharedTexture() secretly installs an Electron receiver
export const consumeSharedTexture = (handlers) => {
  ensureReceiverInstalled();          // hidden side effect
  return pool.register(handlers);
};

// ✅ Two single-responsibility functions
export const installSharedTextureReceiver = (): void => {
  if (installed) return;              // idempotent init, but EXPLICIT
  installed = true;
  sharedTexture.setSharedTextureReceiver(pool.dispatch);
};

export const consumeSharedTexture = (handlers) => {
  return pool.register(handlers);     // pure pool registration, nothing else
};
```

Callers do `installSharedTextureReceiver()` once at app startup, then `consumeSharedTexture(...)` freely.

## Common Rationalizations (and rebuttals)

| Excuse | Reality |
|---|---|
| "Lazy init is more ergonomic — one call vs two" | Callers lose track of WHEN the side effect happens. Debuggers, tests, and reviewers pay the cost forever. Two visible calls beat one lying call. |
| "The init is idempotent, so it's safe" | Idempotency is about correctness, not honesty. The function still lies about its own name. |
| "We avoid module-load side effects this way" | Module-load side effects are one extreme. Hidden register-time init is the other. Explicit `install()` at app startup is the right middle ground. |
| "The caller shouldn't need to know about init" | They DO need to know — for tests, teardown ordering, error handling, and debugging. Hiding it in a nominal-register function just delays discovery to an inconvenient moment. |
| "It's just one function — splitting is overkill" | Two three-line functions with one responsibility each beat one six-line function that does two things. Line count is not the metric. |
| "The side effect is an implementation detail" | If it changes observable system state (an Electron slot bound, a listener attached, a file opened), it is not a detail. It is part of the contract. |

## Red Flags — STOP and Split

- `ensureXxx()` called at the top of a function whose name is not "ensure"
- Module-level flag variable (`installed`, `initialized`, `started`) gating setup inside a feature method
- Function docstring that begins with "on first call, also ..."
- Test cases named `"installs X on first register"`, `"re-installs when Y returns"`, etc. — the test names literally advertise the hidden behavior
- A single commit that changes both "registration logic" and "receiver installation" in the same function

All of these mean: extract the hidden responsibility into its own named function and export it.

## Why It Matters

Hidden side effects mean:
- Callers cannot predict ordering (did install happen yet?)
- Teardown is asymmetric — init was automatic, teardown isn't
- Tests must reset hidden module-level state via test-only helpers
- Refactoring the "main" responsibility may accidentally change the init behavior
- Documentation rot: "on first call also..." becomes wrong as the code evolves
- The mental model of "what does this function do?" diverges from the name

Two functions with one responsibility each are boring, honest, and correct. Prefer them.

## Real Case (This Repo)

`packages/renderer/src/client/shared-texture-consumer.ts` originally exposed:

```typescript
consumeSharedTexture(handlers)  // also installed Electron receiver on first call
```

Tests had `"installs the pool receiver on first register"` — that test name was the red flag. Split into:

```typescript
installSharedTextureReceiver()  // explicit idempotent install
consumeSharedTexture(handlers)  // pure pool registration
```

Pre-condition is now documented on `consumeSharedTexture`: caller must have invoked `installSharedTextureReceiver()` at app startup.
