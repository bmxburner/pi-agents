# flow/ — owned spawn core (origin: kky42/pi-flow)

Single owned copy — there is no second source to skew against, so there is
no version guard. Fleet deltas from upstream live in `core/spawn.ts`
(`onSessionFile` + `onSession` hooks) and `profiles.ts` (bundle-aware
`subagents/` resolution).

Kept (spawn dependency closure + profiles): `core/`, `profiles.ts`,
`types.ts`, `subagents/general-purpose.md`.
Dropped: `workflow/` (unused — `run_workflow` is out of scope).

Base: upstream **v3.1.3**, commit `ef0e8f06ffd9cb962451bb07207919144a904bcd`
(2026-08-13), plus the two adaptations above. The ref is now pinned, so a
sync can diff against an exact tree instead of a version guess.

Licensing: pi-flow is MIT (Copyright (c) kky42). The vendored copy is
redistributed under the same terms; see `../NOTICE`.

Sync: `diff -r flow/ <upstream-checkout>/src/` (ignoring this file's
concerns) and port what matters. Upstream: https://github.com/kky42/pi-flow
— ref `v3.1.3`, commit `ef0e8f06ffd9cb962451bb07207919144a904bcd`.

Do NOT add a dependency on the npm package named `pi-flow`: that name is
held by an unrelated project. Depend on this vendored copy, or on the git
ref above.
