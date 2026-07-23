---
'playwriter': minor
---

Isolate browser tabs per git worktree, with zero-click tab creation.

Each git worktree now gets its own tabs in its own distinctly colored tab group. Two Claude sessions running in the same worktree deliberately share that group and see the same tabs; sessions in different worktrees are fully isolated and can never see or drive each other's tabs. Playwriter auto-creates the first tab for a worktree with no setup, so there is no extension icon to click.

Clicking the extension icon now drops the current tab into a shared grey **freestyle** group that carries no worktree ownership. Freestyle tabs are never visible to or drivable by any agent — use them for tabs you want to keep to yourself.

Behavior changes to be aware of:

- **`PLAYWRITER_AUTO_ENABLE` is removed.** Tab auto-creation is now unconditional, so the flag no longer has any meaning. A manually enabled (clicked) tab is freestyle and can never be driven by an agent, which made the old "require manual enabling" mode incoherent.
- **`PLAYWRITER_SESSION` no longer influences tab isolation inside a git repo.** Tab isolation is derived from your git worktree. Set `PLAYWRITER_WORKSPACE` to an explicit value to override it: the same value shares tabs across directories, a different value isolates them.
- **The browser extension must be updated in lockstep with the CLI.** A stale extension no longer reports workspace ownership, which would silently hide every tab. Playwriter now detects this and raises an explicit error telling you to reload the unpacked extension at `chrome://extensions`, instead of returning an empty page list.
