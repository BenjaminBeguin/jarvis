# External / community modules

## Why

Today, modules live in `electron/main/modules/` and ship as part of the
app bundle. Adding one requires editing the codebase, recompiling, and
restarting. The vision in CLAUDE.md mentions external/community
modules: drop a folder into `~/.jarvis/modules/<id>/`, restart, it
loads.

This unlocks:
- The user writing their own integrations without touching the repo.
- Sharing modules (open-source repo of community modules).
- Faster experimentation — no rebuild loop.

## What

A loader for `~/.jarvis/modules/<id>/` directories. Each module follows
the same `Module` shape we already use. Loaded at app startup via
dynamic import. Sandboxed: runs in a Worker thread with a typed
capability bridge to ModuleContext — no direct fs / network / process
access.

Sample module:

```
~/.jarvis/modules/timer/
  module.json           { id, name, version, capabilities: ['notify'] }
  index.js              the Module export, plain JS
  README.md             user-facing docs
```

## How (rough)

- **Discovery**: on startup, `readdirSync('~/.jarvis/modules/')`,
  filter to dirs with a `module.json`.
- **Sandbox**: each module runs in a Node `worker_threads` Worker.
  Capabilities granted via the module.json's `capabilities` list (and
  the user has to approve on first install). The worker can ONLY
  call functions on a `MessagePort` bridge that maps to a curated
  subset of `ModuleContext`.
- **Hot reload**: chokidar watch each module dir; reload its worker
  on file change. Worth doing for dev experience.
- **Validation**: the loader parses module.json with a schema, refuses
  modules that don't declare their capabilities. Refuses ones that
  import disallowed Node built-ins (static check at load time).
- **UI**: Modules tab shows external modules separately, with a
  capabilities summary and an Uninstall button.

## Tradeoffs / risks

- **Sandbox quality**. Worker threads aren't a security boundary
  against determined attackers — Node has too many escape hatches.
  This is "good enough for trusted user-installed code", not "good
  enough for arbitrary npm packages". Document the threat model
  honestly.
- **API stability**. Once external modules exist, ModuleContext is a
  public API; breaking changes hurt. Version the bridge.
- **Curation**. Without curation, the ecosystem is a bunch of
  abandoned half-finished modules. Phase 1: just allow user-local
  modules. Phase 2: an official registry. Phase 3: community.

## Effort

~1 week including sandbox + UI. The protocol design is the main
investment; the wiring is straightforward.

## Related

- [Skill chaining](./skill-chaining.md) — similar in spirit (sub-agents
  vs sub-modules) but orthogonal.
