# pi-agents

Subagent lifecycle for [pi](https://github.com/earendil-works/pi): spawn, watch, steer, and stop child agents. One surface — the **footer** below the chat input, one line per agent (`↓` to inspect, steer, stop). Orca-only panes; pi in-process by default.

> **Attribution:** pi-agents is a hard adaptation of [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) (via [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)). It also vendors a pinned copy of the [kky42/pi-flow](https://github.com/kky42/pi-flow) spawn core in [`flow/`](flow/) (v3.1.3). All three upstreams are MIT; see [NOTICE](NOTICE) for full attribution.

---

## What it does

| Capability | Description |
|---|---|
| **Spawn** | Unified `subagent` tool — **in-process by default** (`interactive:false`, an AgentSession in this pi process, sync result when done) or in a dedicated **Orca terminal pane** (`interactive:true`, async `{id,surface}`). |
| **Watch** | Footer rows below the chat input: `ip-` rows for in-process runs (fed live by the AgentSession event stream), snapshot rows for pane runs. `↓` opens the footer, `/subagents` reviews finished ones. |
| **Steer** | Row actions: `Enter` inspect (in-process transcript tail / pane live tail), message-to-steer, `f` jump to the Orca pane, `x` abort, `X` close. `subagent_wait` blocks for a result; `subagent_interrupt` interrupts a turn. |
| **Resume** | `subagent_resume` attaches to an existing subagent session; `session_key` resumes a prior in-process conversation. |
| **Structure** | `schema` (portable strict JSON Schema, root type object; in-process only) makes the child return via a terminating `structured_output` tool call; the validated value comes back in `details.structured`. |
| **Limit** | Graceful turn limits so a runaway child cannot burn the budget forever. |

## Spawn modes

`subagent` accepts a `mode` that selects how isolated the child runs:

| mode | isolation |
|---|---|
| `fork` (default) | lightweight Orca pane in the current worktree |
| `worktree` | git-worktree isolation (`orca worktree create` + terminal in it) |

**Backend selection** is strict: Orca is the only backend, used ONLY when the
environment verifiably hosts this process — never by availability probe:

- `PI_SUBAGENT_BACKEND=orca` → **forced**
- `ORCA_PANE_KEY` set **and** orca daemon ready → **orca**
- otherwise → **none** — subagents unavailable, with a setup hint
  (a reachable daemon on the machine is NOT proof of hosting: Warp/plain
  shell with an orca daemon running elsewhere still resolves to none)

## Unified subagent tool + owned flow core

| `interactive` | Runner | Result | Footer row |
|---|---|---|---|
| `false` (default) | in-process `AgentSession` (owned flow spawn core) | **sync** — returns the final text when done | live `ip-` row fed by session events; peek reads the persisted session transcript |
| `true` | Orca terminal pane | **async** — `{id, surface}` immediately | snapshot row with live tail on inspect |

Both modes persist their session to `~/.pi/agent/subagent-sessions/`, so peek works for in-process rows too. `thinking` overrides the level.

Background panes (`interactive:true`, pi or CLI backend) launch with an operating contract distilled from [orca-sdlc-kit](https://github.com/vankhangfet/orca-sdlc-kit)'s field scars: autonomy rules (record assumptions, never stall on questions — the parent steers), a running-checklist convention so progress survives interruption, and a compact Result/Output/Evidence/Learnings report on completion. Large pane sends (>2000 chars) get a delayed bare-Enter nudge — big pastes can collapse into an input chip that swallows Enter or drop silently while the CLI reports ok.

### Owned flow core

`flow/` is an owned copy of the pi-flow spawn core (origin [`kky42/pi-flow`](https://github.com/kky42/pi-flow) v3.1.3 — see `flow/UPSTREAM.md` for sync notes): `core/` (spawn dependency closure), `profiles.ts`, `types.ts`, and `subagents/general-purpose.md`.

- **Fleet hooks:** `spawn.ts` exposes `onSessionFile` (live preview) and `onSession` (live `AgentSession` for steer/abort); `profiles.ts` resolves the bundled `subagents/` dir in source and bundled layouts.
- **owning `run_agent`:** NOT SUPPORTED. `npm:@kky42/pi-flow` is the single owner of `run_agent`/`run_workflow` (dual-ownership hazard — pi-agents loads first and would silently shadow pi-flow).

## Install

pi-agents is source-built: no npm registry distribution is involved.

1. Copy (or symlink) this directory next to your other pi extensions, e.g.:
   ```bash
   mkdir -p ~/.pi/agent/extensions/pi-agents
   ln -sf <this-dir>/index.js ~/.pi/agent/extensions/pi-agents/index.js
   ```
2. Restart pi. The auto-discovery scanner picks up the symlinked `index.js`.

> The `path:` mechanism in pi's `settings.json` silently fails on some setups — the symlink above is the reliable option. See `~/.pi/agent/AGENTS.md` → *Pi Infrastructure Quirks*.

## Build

`index.js` is precompiled from `index.ts` with esbuild (eliminates jiti compile time at pi startup):

```bash
npm run build      # from this directory
```

## License

MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for upstream attribution.
