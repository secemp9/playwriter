// Todo 21 — durable state for workspace-aware tabs, held in chrome.storage.session.
//
// WHY chrome.storage.session (verified from the official docs): "Session storage holds
// data in memory while an extension is loaded. The storage is cleared if the extension
// is disabled, reloaded, updated, and when the browser restarts." MV3 terminates the
// service worker aggressively, but an idle SW termination does NOT unload the extension,
// so this data survives exactly the event we must survive (SW death) while being wiped on
// the events we WANT a fresh start for (reload / update / browser restart). That last
// point matters for the group map below: chrome tab-group IDs are "unique within a browser
// session" and go stale across a restart — session storage's lifetime matches theirs.
//
// Two independent records live here:
//
//   tabOwners : Record<tabId, { workspaceKey, workspaceLabel }>
//     Persisted per-tab ownership so a tab's workspace survives SW death. The in-memory
//     store.tabs map starts empty on every SW start; without this record a restart would
//     silently wipe every tab's workspaceKey and its group membership would evaporate.
//     On startup rehydrateTabOwners() re-reads it, DROPS entries whose OS tab no longer
//     exists, and returns the survivors so background.ts can repopulate store.tabs as
//     'connecting' and let maintainLoop's existing re-attach path restore each tab WITH
//     ownership intact. Todo 21 owns BOTH ends of this record.
//
//   groupIds : Record<workspaceKey | '__freestyle__', groupId>
//     The single source of tab-group IDENTITY (invariant I5): no code may look a group up
//     by title. Written and read by Todo 22 (per-key worktree groups + the one shared
//     freestyle group) and Todo 23 (reverse lookup for manual group/ungroup). Todo 21 only
//     provides the typed accessors; it does not populate this record.
//
// All access to both records is serialized through a single in-module promise chain so a
// set immediately followed by a delete for the same key applies in call order, never
// racing on the underlying read-modify-write.

import type { TabInfo } from './types'

/** The two ownership fields carried per tab. Kept in lockstep with TabInfo via Pick. */
export type TabOwner = Pick<TabInfo, 'workspaceKey' | 'workspaceLabel'>

/**
 * The map key for the single SHARED freestyle group (D3): every human-clicked/freestyle
 * tab (workspaceKey === null) shares ONE grey group. Namespaced with underscores so it can
 * never collide with a real workspace key (which is always prefixed 'wt:' / 'cwd:' / 'x:').
 */
export const FREESTYLE_GROUP_KEY = '__freestyle__'

const TAB_OWNERS_STORAGE_KEY = 'playwriterTabOwners'
const GROUP_IDS_STORAGE_KEY = 'playwriterGroupIds'

// Serialize every read-modify-write so concurrent mutations cannot clobber each other.
// Errors are isolated: a failed op rejects its own returned promise but does not break the
// chain for subsequent ops.
let storageQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = storageQueue.then(op, op)
  storageQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function readTabOwners(): Promise<Record<string, TabOwner>> {
  const result = await chrome.storage.session.get(TAB_OWNERS_STORAGE_KEY)
  // An absent record is the true, correct state on a fresh extension load — "nothing has
  // been persisted yet", not a missing required value being papered over. Represent it as {}.
  return (result[TAB_OWNERS_STORAGE_KEY] as Record<string, TabOwner> | undefined) ?? {}
}

async function readGroupIds(): Promise<Record<string, number>> {
  const result = await chrome.storage.session.get(GROUP_IDS_STORAGE_KEY)
  return (result[GROUP_IDS_STORAGE_KEY] as Record<string, number> | undefined) ?? {}
}

/** Read the full tab-ownership record (string tabId → owner). */
export function getTabOwners(): Promise<Record<string, TabOwner>> {
  return enqueue(readTabOwners)
}

/** Persist (or overwrite) the owning workspace for a tab. Called on every ownership stamp. */
export function setTabOwner(tabId: number, owner: TabOwner): Promise<void> {
  return enqueue(async () => {
    const owners = await readTabOwners()
    owners[String(tabId)] = { workspaceKey: owner.workspaceKey, workspaceLabel: owner.workspaceLabel }
    await chrome.storage.session.set({ [TAB_OWNERS_STORAGE_KEY]: owners })
  })
}

/** Drop a tab's persisted ownership. Called when a tab is deliberately disconnected/closed. */
export function deleteTabOwner(tabId: number): Promise<void> {
  return enqueue(async () => {
    const owners = await readTabOwners()
    if (!(String(tabId) in owners)) return
    delete owners[String(tabId)]
    await chrome.storage.session.set({ [TAB_OWNERS_STORAGE_KEY]: owners })
  })
}

/** Read the full group-identity map (workspace key / '__freestyle__' → chrome group id). */
export function getGroupIds(): Promise<Record<string, number>> {
  return enqueue(readGroupIds)
}

/** Record the chrome tab-group id for a workspace key (or FREESTYLE_GROUP_KEY). */
export function setGroupId(key: string, groupId: number): Promise<void> {
  return enqueue(async () => {
    const map = await readGroupIds()
    map[key] = groupId
    await chrome.storage.session.set({ [GROUP_IDS_STORAGE_KEY]: map })
  })
}

/** Forget the chrome tab-group id for a workspace key (or FREESTYLE_GROUP_KEY). */
export function deleteGroupId(key: string): Promise<void> {
  return enqueue(async () => {
    const map = await readGroupIds()
    if (!(key in map)) return
    delete map[key]
    await chrome.storage.session.set({ [GROUP_IDS_STORAGE_KEY]: map })
  })
}

/**
 * SW-startup rehydration of tab ownership. Reads the persisted tabOwners record, queries
 * the live tabs, DROPS (and prunes from storage) any entry whose OS tab no longer exists,
 * and returns the survivors as a Map<tabId, TabOwner> for background.ts to fold back into
 * store.tabs as 'connecting'. Dropping dead tabs is not a fallback — a closed tab can never
 * be re-attached, so keeping it would leak forever and, worse, could later collide with a
 * recycled tab id.
 */
export async function rehydrateTabOwners(): Promise<Map<number, TabOwner>> {
  return enqueue(async () => {
    const owners = await readTabOwners()
    const liveTabs = await chrome.tabs.query({})
    const liveIds = new Set<number>()
    for (const tab of liveTabs) {
      if (tab.id !== undefined) liveIds.add(tab.id)
    }

    const survivors = new Map<number, TabOwner>()
    let pruned = false
    for (const [key, owner] of Object.entries(owners)) {
      const tabId = Number(key)
      if (!Number.isInteger(tabId) || !liveIds.has(tabId)) {
        delete owners[key]
        pruned = true
        continue
      }
      survivors.set(tabId, { workspaceKey: owner.workspaceKey, workspaceLabel: owner.workspaceLabel })
    }

    if (pruned) {
      await chrome.storage.session.set({ [TAB_OWNERS_STORAGE_KEY]: owners })
    }
    return survivors
  })
}
