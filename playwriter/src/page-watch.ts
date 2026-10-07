/**
 * page-watch.ts — what happened on the page, and is it done yet.
 *
 * A person who clicks "Send" in a chat app does not read the page the instant the mouse
 * button comes up: they wait until the spinner stops and the reply has finished typing
 * itself out, and they notice the toast that flashed "Saved" for half a second. Weak
 * models driving the browser did neither (double posts while the app still said
 * "Processing", reading half-rendered replies, missing error toasts). This module gives
 * the executor those two human faculties:
 *
 *  - a JOURNAL of everything that happened after a checkpoint, in every frame of the page:
 *    requests (one record per redirect hop, with failures), WebSocket frames, console errors
 *    and uncaught exceptions of the page's own code (each frame's main world) with their call
 *    site, navigations of the main frame (a full document load — which wipes every client
 *    cache —, a back/forward-cache restore, or an SPA route change), native dialogs, live text
 *    that appeared (live regions, dialogs, newly inserted top-layer or fixed overlays; flagged
 *    `transient` when already gone when read), and how much content changed;
 *  - a SETTLE step: wait until content stopped changing AND the requests the action caused
 *    finished, or say exactly why not (which requests are still open, which element is still
 *    changing, what still looks busy). `waitForIdle` additionally waits until nothing
 *    STRONGLY says "still working" — that is how an agent waits for an AI reply to finish
 *    streaming before reading it.
 *
 * Ground truth only. "Busy" comes from what the page states (the accessibility tree's
 * `busy`, a progressbar's value and whether it moved, endlessly repeating animations that
 * are actually on screen and on top) and from measurements (content still changing,
 * response bytes still arriving). Which requests matter comes from CDP request facts
 * (resource type, ad tagging) and from causality: only requests that started after the
 * action began can hold its settle. No host lists, no words, no class names.
 *
 * Nothing is added to the page under test. Network and console facts come from CDP events on
 * Playwright's own sessions, which Playwright already enabled (this module never sends
 * `*.enable`/`*.disable`): the page's session, which also carries every same-process iframe,
 * the session of each out-of-process iframe (a cross-site iframe under site isolation), whose
 * requests and console Chrome reports there only, and the session of each dedicated worker
 * (nested ones too), whose requests, console and exceptions Chrome reports there only (a worker
 * runs nothing but its own code, so its console needs no identifying). Request and execution context ids
 * are per session, so everything keyed by them is kept per session. Iframe and worker sessions are
 * followed from their first event: Playwright resumes the iframe's renderer or the worker as it
 * attaches, before this module could borrow the session (and a worker's cannot be borrowed at
 * all), so their events are taken from a tap on Playwright's in-process server that holds them
 * from the session's creation (`session-tap.ts`). Navigations are the main frame's (an
 * iframe loading is not the page navigating). Native dialogs come from the page's
 * DialogController (one state machine for the whole layer). DOM facts come from a
 * MutationObserver in every frame's own CDP isolated world (`page-frames.ts`), one journal per
 * frame document: settle, busy signals and `since()` read them all, so a payment iframe's
 * spinner or a consent wall's text counts like the main document's. Each observer covers its
 * document and every shadow root in it (open ones as they appear, closed ones found through
 * DOMSnapshot): it shares the DOM but its globals — including the journal reader
 * `__playwriterWatch` — are invisible to page scripts. It only reads; it never writes to the DOM.
 *
 * Content vs cosmetic vs ambient mutations: style/class-only changes are counted separately
 * and never delay settling (JS-driven animations rewrite `style` forever). Changes inside
 * timer, marquee and aria-live=off regions — by ARIA's own definition not news — are
 * ambient. So are changes of elements that were already changing continuously before the
 * action began (a clock, a ticker, a reply still streaming from an earlier step): they are
 * listed once in the settle result and do not hold this action's quiet.
 *
 * Clocks: the browser stamps in-page journal entries (the isolated world's `Date.now()`) and
 * requests (`wallTime`); this process stamps checkpoints, input ends and every event's arrival.
 * Chrome may run on another machine (a cloud browser, a remote relay), whose clock can be minutes
 * off, so the two are never compared directly: every journal read is a timed round trip that
 * measures the offset between them (`browser-clock.ts`), checkpoints are converted to the
 * browser's clock before they are compared with its stamps, and browser times are converted to
 * this process's clock before they leave this module. Quiet windows are durations on one clock.
 */

import type { Frame } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'
import { BrowserClock } from './browser-clock.js'
import type { ICDPSession } from './cdp-session.js'
import { FrameGoneError, SealedFrameError } from './cdp-session.js'
import { PageUnresponsiveError, withDeadline } from './isolated-world.js'
import type { IsolatedWorld } from './isolated-world.js'
import type { FrameChange, FrameEntry, FrameHandle, PageFrames } from './page-frames.js'
import {
  ModelFacingError,
  type BusySignal,
  type ConsoleRecord,
  type JsDialogState,
  type LiveTextRecord,
  type NavigationRecord,
  type NetworkRecord,
  type PendingRequest,
  type SettleResult,
  type WatchCheckpoint,
  type WatchEvents,
  type WebSocketFrameRecord,
} from './probe-types.js'
import { PageSessionTap, type SessionTap, type TapListener, type TappedEvent, type TappedSession, type TappedWorker } from './session-tap.js'

const REQUEST_CAP = 500
const CONSOLE_CAP = 500
const NAVIGATION_CAP = 200
const DIALOG_CAP = 100
const WEBSOCKET_CAP = 2000
/** Documents whose in-page journal is kept after their frame navigated away from them (or went away). */
const DOCUMENT_CAP = 5
const BODY_CAP_CHARS = 64 * 1024
const CONSOLE_TEXT_CAP = 2000
/** Settle poll period. One poll is a single Runtime.evaluate of a few fields (~1-3ms locally). */
const POLL_MS = 75
/** Per-probe deadline inside settle: long enough for a busy renderer, short enough to notice a wedge. */
const PROBE_TIMEOUT_MS = 3000
/** How often a long wait looks again for shadow roots the page attached without a DOM mutation (closed ones, late upgrades). */
const ROOT_DISCOVERY_MS = 1000
/** A response whose last body bytes arrived within this window is still streaming. */
const STREAM_RECENT_MS = 500
/** An open request with no response yet, older than this, is reported as held by the server. */
const HELD_REQUEST_MS = 2000
/** Image/Font/Media requests that received nothing for this long stop holding quiet (a stalled asset, not the action's effect). */
const STALLED_ASSET_MS = 3000
const SETUP_NAME = 'page-watch'
const READER = '__playwriterWatch'

/**
 * CDP resource types that never hold quiet: Chrome's own classification of traffic a person
 * never waits on (beacons, CSP reports, prefetches, browser-internal "Other"), and channels
 * that are open by design for the life of the page.
 */
const NEVER_HOLDS: Record<string, true> = { Ping: true, CSPViolationReport: true, Prefetch: true, Other: true, WebSocket: true, EventSource: true }
/** Types whose request stops holding quiet once it stalled (no bytes for STALLED_ASSET_MS). */
const STALLABLE: Record<string, true> = { Image: true, Font: true, Media: true }
/** Types whose response body can stream into the page (chunks a person watches arrive). */
const STREAMABLE: Record<string, true> = { Fetch: true, XHR: true, EventSource: true }
const EVENT_STREAM_MIME = 'text/event-stream'
const TEXTUAL_MIME_RE = /^(text\/|application\/(json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql)|image\/svg\+xml)|\+(json|xml)$/i
const DEAD_CONTEXT_RE = /Cannot find context with specified id|Execution context was destroyed|Cannot find execution context|Inspected target navigated or closed/i
const CLOSED_RE = /Target (page, context or browser )?(has been )?closed|Session closed|has been closed|Target closed/i
/** Chrome's answer when two remote objects live in different execution contexts. */
const OTHER_WORLD_RE = /same JavaScript world/i
/** Chrome's answer when nothing is hit at a viewport point. */
const NO_NODE_AT_POINT_RE = /No node found at given location/i
/** frameStartedNavigating types that stay in the same document (navigatedWithinDocument reports those). */
const SAME_DOCUMENT_NAVIGATIONS: Record<string, true> = { historySameDocument: true, sameDocument: true }
/** Where the main frame's viewport, and the page session's coordinates, are on the screen: identity. */
const IDENTITY_BOX = { x: 0, y: 0, scale: 1 }

/**
 * The in-page half of the journal, run once in every fresh copy of the isolated world.
 *
 * Plain ES5-style JavaScript in a string (not a stringified TS function) so the bundler
 * cannot inject helpers that do not exist in the page realm. It must never write to the
 * DOM or to the page's main-world globals: everything it keeps lives in the isolated
 * world's own global object.
 *
 * The world is found by name, so a tab that outlived a relay restart or an upgrade still holds
 * the journal another build installed (measured: its `busy()` had no `spinners`). The install
 * is keyed by `__WATCH_VERSION__` — a hash of this very source — and a journal of any other
 * version is stopped and replaced; the same version is reused (two sessions on one tab).
 */
const WATCH_SOURCE_TEMPLATE = String.raw`(function () {
  'use strict';
  var VERSION = '__WATCH_VERSION__';
  var existing = globalThis.__playwriterWatch;
  if (existing && existing.version === VERSION) return;
  if (existing && typeof existing.stop === 'function') existing.stop();
  else if (existing) delete globalThis.__playwriterWatch;
  // Live semantics are ARIA's: live-region roles, an explicit polite/assertive aria-live, <output>.
  var LIVE_SEL = '[role=status],[role=alert],[role=log],[aria-live=polite],[aria-live=assertive],output';
  var DIALOG_SEL = 'dialog[open],[role=dialog],[role=alertdialog]';
  var WATCH_SEL = LIVE_SEL + ',' + DIALOG_SEL;
  // ARIA defines timer and marquee as aria-live=off: their churn is not news.
  var AMBIENT_SEL = '[role=timer],[role=marquee],[aria-live=off],marquee';
  var COSMETIC = { 'class': true, style: true };
  var VALUE_ATTRS = { 'aria-valuenow': true, value: true };
  var CONTAINER_TAGS = { LI: 1, ARTICLE: 1, SECTION: 1, P: 1, TD: 1, TH: 1, PRE: 1, BLOCKQUOTE: 1, MAIN: 1, DIALOG: 1, FORM: 1, UL: 1, OL: 1, TABLE: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, NAV: 1, ASIDE: 1, HEADER: 1, FOOTER: 1 };
  var IMPLICIT_ROLE = { OUTPUT: 'status', PROGRESS: 'progressbar', DIALOG: 'dialog', NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', FORM: 'form', UL: 'list', OL: 'list', LI: 'listitem', BUTTON: 'button', ARTICLE: 'article', TABLE: 'table', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', TEXTAREA: 'textbox', SELECT: 'combobox', MARQUEE: 'marquee', IMG: 'img' };
  var OBSERVE = {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['aria-busy', 'aria-expanded', 'aria-hidden', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-disabled', 'aria-invalid', 'aria-valuenow', 'aria-valuetext', 'disabled', 'hidden', 'open', 'popover', 'value', 'checked', 'selected', 'data-state', 'class', 'style']
  };
  // dom-streaming means SUSTAINED change (text arriving chunk by chunk), not "something changed a
  // moment ago": a single re-render after a click must not read as "the app is still working".
  var BATCH_CAP = 5000, LIVE_CAP = 500, TARGETS_KEEP_MS = 60000, STREAM_WINDOW_MS = 1500, STREAM_MIN_BATCHES = 3, STREAM_RECENT_MS = 500;
  // An element is churning when it changed at least CHURN_MIN_CHANGES times with gaps of at most CHURN_GAP_MS.
  var CHURN_GAP_MS = 2000, CHURN_MIN_CHANGES = 3, SPINNER_SETS_KEPT = 4;

  var token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  var installedAt = Date.now();
  var totals = { content: 0, cosmetic: 0, ambient: 0 };
  var batches = [];
  var nextBatchId = 1;
  var lastDroppedAt = null;
  var live = [];
  var nextLiveId = 1;
  var liveDroppedAt = null;
  var shownText = new WeakMap();
  var lastRecordFor = new WeakMap();
  var streaks = new WeakMap();
  var valueChangedAt = new WeakMap();
  var overlays = new WeakSet();
  var observed = new WeakSet();
  var roots = [];
  var spinnerSets = {};
  var nextSpinnerSet = 1;

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }
  /** Parent in the flat tree: a shadow root's children belong to its host. */
  function parentOf(node) {
    var p = node.parentNode;
    if (!p) return null;
    if (p.nodeType === 11) return p.host || null;
    return p.nodeType === 1 ? p : null;
  }
  function elementOf(node) {
    if (node.nodeType === 1) return node;
    if (node.nodeType === 11) return node.host || null;
    return parentOf(node);
  }
  function closestFlat(el, sel) {
    for (var e = el; e; e = parentOf(e)) if (e.matches(sel)) return e;
    return null;
  }
  function shown(el, strict) {
    if (!el || !el.isConnected || el.nodeType !== 1) return false;
    var opts = strict
      ? { visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true, checkOpacity: true }
      : { visibilityProperty: true, checkVisibilityCSS: true };
    if (!el.checkVisibility(opts)) return false;
    if (!strict) return true;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r && norm(r)) return norm(r).split(' ')[0];
    if (el.tagName === 'A' && el.hasAttribute('href')) return 'link';
    if (el.tagName === 'SECTION' && (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby'))) return 'region';
    return IMPLICIT_ROLE[el.tagName] || '';
  }
  function nameOf(el) {
    var n = norm(el.getAttribute('aria-label'));
    if (n) return clip(n, 60);
    var ids = el.getAttribute('aria-labelledby');
    if (ids) {
      var scope = el.getRootNode();
      var parts = [];
      norm(ids).split(' ').forEach(function (id) { var x = scope.getElementById ? scope.getElementById(id) : null; if (x) parts.push(norm(x.textContent)); });
      var t = norm(parts.join(' '));
      if (t) return clip(t, 60);
    }
    var title = norm(el.getAttribute('title'));
    return title ? clip(title, 60) : '';
  }
  function cssLabel(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + clip(el.id, 32);
    var cls = norm(el.getAttribute('class'));
    if (cls) cls.split(' ').slice(0, 2).forEach(function (c) { s += '.' + clip(c, 32); });
    return s;
  }
  function textOf(el, n) {
    var t = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return clip(norm(t), n);
  }
  function describe(el, textLen) {
    var role = roleOf(el), name = nameOf(el);
    if (role && name) return role + ' "' + name + '"';
    if (name) return cssLabel(el) + ' "' + name + '"';
    var text = textLen ? textOf(el, textLen) : '';
    var base = role || cssLabel(el);
    return text ? base + ' "' + text + '"' : base;
  }
  /** What a person would call the place where \`el\` changed: its nearest named container and region. */
  function placeOf(el) {
    if (!el || !el.isConnected) return null;
    var target = el, hops = 0;
    while (target && hops < 6 && !(target.getAttribute('role') || target.getAttribute('aria-label') || target.id || CONTAINER_TAGS[target.tagName])) {
      target = parentOf(target);
      hops++;
    }
    if (!target || target === document.documentElement || target === document.body) target = el;
    var label = describe(target, 50);
    var up = parentOf(target);
    var region = up && closestFlat(up, '[role],[aria-label],main,nav,aside,dialog,form,article');
    if (region && region !== document.body) {
      var rr = roleOf(region), rn = nameOf(region);
      if (rr && rn) label += ' in ' + rr + ' "' + rn + '"';
      else if (rr) label += ' in ' + rr;
    }
    return label;
  }
  function liveRole(el) {
    var r = roleOf(el);
    if (r === 'status' || r === 'alert' || r === 'log' || r === 'dialog' || r === 'alertdialog') return r;
    var politeness = el.getAttribute('aria-live');
    if (politeness === 'assertive') return 'alert';
    if (politeness === 'polite') return 'status';
    return r || 'status';
  }
  /** The live region or overlay that announces a change at \`el\`; a chat log's news is the message that changed, not the whole conversation. */
  function announcer(el) {
    for (var e = el, child = null; e; child = e, e = parentOf(e)) {
      if (overlays.has(e)) return { el: e, role: 'overlay' };
      if (!e.matches(WATCH_SEL)) continue;
      if (roleOf(e) === 'log' && child) return { el: child, role: 'log' };
      return { el: e, role: liveRole(e) };
    }
    return null;
  }
  /** A newly inserted subtree a person notices on top of the page: the top layer, or fixed/sticky positioning. */
  function overlayRole(el) {
    if (el.matches(':popover-open')) return 'popover';
    if (el.matches(':modal')) return 'dialog';
    var position = getComputedStyle(el).position;
    return position === 'fixed' || position === 'sticky' ? 'overlay' : null;
  }
  function recordLive(el, role, now, seenTexts) {
    if (!shown(el, false)) { shownText.delete(el); return; }
    var text = textOf(el, 300);
    if (!text) { shownText.delete(el); return; }
    if (shownText.get(el) === text) return;
    shownText.set(el, text);
    if (seenTexts[text]) return;
    seenTexts[text] = true;
    var prev = lastRecordFor.get(el);
    var retained = prev && live.length && prev.id >= live[0].id;
    if (retained && (role === 'log' || text.slice(0, 20) === prev.text.slice(0, 20))) {
      prev.text = text;
      prev.updatedAt = now;
      return;
    }
    var rec = { id: nextLiveId++, at: now, updatedAt: null, role: role, text: text, ref: new WeakRef(el) };
    live.push(rec);
    lastRecordFor.set(el, rec);
    if (live.length > LIVE_CAP) liveDroppedAt = live.shift().at;
  }

  var observer = new MutationObserver(onMutations);
  function observeRoot(root) {
    if (observed.has(root)) return false;
    observed.add(root);
    observer.observe(root, OBSERVE);
    if (root.nodeType === 11) roots.push(new WeakRef(root));
    return true;
  }
  /** Observe every open shadow root at or under \`node\` (nested ones too); \`onNewRoot\` sees each one observed for the first time. */
  function adopt(node, onNewRoot) {
    var pending = [node];
    function take(root) {
      if (!observeRoot(root)) return;
      pending.push(root);
      if (onNewRoot) onNewRoot(root);
    }
    while (pending.length) {
      var scope = pending.pop();
      if (scope.nodeType === 1 && scope.shadowRoot) take(scope.shadowRoot);
      var walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      var el;
      while ((el = walker.nextNode())) if (el.shadowRoot) take(el.shadowRoot);
    }
  }
  function liveRoots() {
    var out = [];
    for (var i = roots.length - 1; i >= 0; i--) {
      var root = roots[i].deref();
      if (!root) { roots.splice(i, 1); continue; }
      if (root.host && root.host.isConnected) out.push(root);
    }
    return out;
  }

  /** Observe open shadow roots attached without a DOM mutation, under the document and every root already observed (closed ones included). */
  function sweep() {
    var pending = [document].concat(liveRoots()), seen = new Set();
    while (pending.length) {
      var scope = pending.pop();
      if (seen.has(scope)) continue;
      seen.add(scope);
      var walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      var el;
      while ((el = walker.nextNode())) {
        if (!el.shadowRoot) continue;
        observeRoot(el.shadowRoot);
        pending.push(el.shadowRoot);
      }
    }
  }

  function noteStreak(el, now) {
    var s = streaks.get(el);
    if (!s || now - s.last > CHURN_GAP_MS) { streaks.set(el, { start: now, last: now, count: 1, churningAt: null }); return; }
    s.last = now;
    s.count++;
    if (s.count === CHURN_MIN_CHANGES) s.churningAt = now;
  }
  /** \`el\` was already changing continuously before \`cutoff\`, and has not stopped since. */
  function churning(el, cutoff) {
    var s = streaks.get(el);
    return !!s && s.start < cutoff && s.churningAt !== null && s.churningAt < cutoff;
  }
  /** The element a content batch counts for, or false when every target was churning before \`cutoff\`. */
  function batchTarget(b, cutoff) {
    if (b.targets === null || b.untargeted) return b.targets && b.targets.length ? b.targets[b.targets.length - 1] : null;
    for (var j = b.targets.length - 1; j >= 0; j--) {
      if (cutoff === null || !churning(b.targets[j], cutoff)) return b.targets[j];
    }
    return false;
  }
  function lastContent(cutoff) {
    for (var i = batches.length - 1; i >= 0; i--) {
      var b = batches[i];
      if (!b.content) continue;
      var t = batchTarget(b, cutoff);
      if (t !== false) return { at: b.at, el: t };
    }
    return { at: lastDroppedAt, el: null };
  }
  function ambientSince(cutoff, from) {
    var seen = new Set(), out = [];
    function note(el) {
      if (seen.has(el) || !el.isConnected) return;
      seen.add(el);
      out.push(describe(el, 40));
    }
    for (var i = batches.length - 1; i >= 0 && batches[i].at >= from; i--) {
      var b = batches[i];
      if (b.ambientEls) b.ambientEls.forEach(note);
      if (cutoff !== null && b.targets) b.targets.forEach(function (t) { if (churning(t, cutoff)) note(t); });
    }
    return out;
  }

  function onMutations(list) {
    var now = Date.now();
    var content = 0, cosmetic = 0, ambient = 0;
    var targets = new Set(), ambientEls = new Set(), watched = new Map(), ambientOf = new Map();
    function watch(el, role) { if (!watched.has(el)) watched.set(el, role || liveRole(el)); }
    function inAmbient(el) {
      if (!ambientOf.has(el)) ambientOf.set(el, closestFlat(el, AMBIENT_SEL));
      return ambientOf.get(el);
    }
    function watchInside(root) {
      var inner = root.querySelectorAll(WATCH_SEL);
      for (var k = 0; k < inner.length; k++) watch(inner[k]);
    }
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var el = elementOf(m.target);
      if (m.type === 'attributes' && el && VALUE_ATTRS[m.attributeName]) valueChangedAt.set(el, now);
      if (m.type === 'attributes' && COSMETIC[m.attributeName]) {
        cosmetic++;
        if (el && el.matches(WATCH_SEL)) watch(el);
        continue;
      }
      var region = el ? inAmbient(el) : null;
      if (region) {
        ambient++;
        ambientEls.add(region);
        continue;
      }
      content++;
      if (el) targets.add(el);
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType !== 1 || !n.isConnected) continue;
          adopt(n, watchInside);
          if (n.matches(WATCH_SEL)) watch(n);
          watchInside(n);
          var overlay = overlayRole(n);
          if (overlay) {
            overlays.add(n);
            watch(n, overlay);
          }
        }
      } else if (m.type === 'attributes' && el && el.matches(DIALOG_SEL)) {
        watch(el);
      }
    }
    targets.forEach(function (t) {
      if (!t.isConnected) return;
      var a = announcer(t);
      if (a) watch(a.el, a.role);
    });
    if (content || cosmetic || ambient) {
      batches.push({
        id: nextBatchId++, at: now, content: content, cosmetic: cosmetic, ambient: ambient,
        targets: content ? Array.from(targets) : null, untargeted: content > 0 && targets.size === 0,
        ambientEls: ambient ? Array.from(ambientEls) : null
      });
      if (batches.length > BATCH_CAP) lastDroppedAt = batches.shift().at;
      // Element references are only needed for recent batches (churn and labels); old ones are counts.
      for (var b = 0; b < batches.length && batches[b].at < now - TARGETS_KEEP_MS; b++) {
        batches[b].targets = null;
        batches[b].ambientEls = null;
      }
      totals.content += content;
      totals.cosmetic += cosmetic;
      totals.ambient += ambient;
    }
    targets.forEach(function (t) { noteStreak(t, now); });
    var seenTexts = {};
    watched.forEach(function (role, el) { recordLive(el, role, now, seenTexts); });
  }

  /** Endlessly repeating animations on screen: candidates for "a spinner a person sees". The host hit-tests them. */
  function spinners() {
    var now = Date.now();
    var anims = document.getAnimations();
    liveRoots().forEach(function (root) { anims = anims.concat(root.getAnimations()); });
    var seen = new Set(), els = [], out = [];
    var vw = innerWidth, vh = innerHeight;
    for (var i = 0; i < anims.length; i++) {
      var a = anims[i];
      if (a.playState !== 'running' || a.timeline !== document.timeline) continue;
      var effect = a.effect;
      if (!effect || !effect.target || effect.getComputedTiming().iterations !== Infinity) continue;
      var el = effect.target;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!el.isConnected || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
      var r = el.getBoundingClientRect();
      var x1 = Math.max(r.left, 0), y1 = Math.max(r.top, 0), x2 = Math.min(r.right, vw), y2 = Math.min(r.bottom, vh);
      if (x2 - x1 < 1 || y2 - y1 < 1) continue;
      out.push({
        label: describe(el, 40) + (a.animationName ? ' (animation ' + a.animationName + ')' : ''),
        startedAt: a.startTime === null ? now : Math.round(performance.timeOrigin + a.startTime),
        x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2)
      });
      els.push(el);
    }
    var id = nextSpinnerSet++;
    spinnerSets[id] = els;
    delete spinnerSets[id - SPINNER_SETS_KEPT];
    return { set: id, list: out };
  }

  function busy(arg) {
    var cutoff = arg.since;
    var now = Date.now(), recent = 0, newest = null, hotEl = null;
    for (var i = batches.length - 1; i >= 0 && now - batches[i].at < STREAM_WINDOW_MS; i--) {
      var b = batches[i];
      if (!b.content) continue;
      var t = batchTarget(b, cutoff);
      if (t === false) continue;
      recent++;
      if (newest === null) { newest = b.at; hotEl = t; }
    }
    var streaming = null;
    if (newest !== null && now - newest < STREAM_RECENT_MS && recent >= STREAM_MIN_BATCHES) {
      var place = placeOf(hotEl);
      streaming = 'content still changing' + (place ? ' in ' + place : '');
    }
    var announced = [];
    if (cutoff !== null) {
      for (var k = 0; k < live.length; k++) {
        var rec = live[k];
        if (rec.at < cutoff && (rec.updatedAt === null || rec.updatedAt < cutoff)) continue;
        if (rec.role === 'dialog' || rec.role === 'alertdialog' || !shown(rec.ref.deref(), false)) continue;
        announced.push(rec.role + ' "' + clip(rec.text, 80) + '"');
      }
    }
    return { streaming: streaming, announced: announced, spinners: spinners() };
  }

  observeRoot(document);
  adopt(document, null);

  globalThis.__playwriterWatch = {
    version: VERSION,
    state: function (arg) {
      var last = lastContent(arg.cutoff);
      return {
        token: token, now: Date.now(), installedAt: installedAt, lastContentAt: last.at,
        hot: arg.labels ? placeOf(last.el) : null,
        ambient: arg.labels && arg.from !== null ? ambientSince(arg.cutoff, arg.from) : [],
        content: totals.content, cosmetic: totals.cosmetic
      };
    },
    read: function (sinceAt) {
      var outLive = [];
      for (var i = 0; i < live.length; i++) {
        var rec = live[i];
        if (rec.at < sinceAt && (rec.updatedAt === null || rec.updatedAt < sinceAt)) continue;
        outLive.push({ id: rec.id, at: rec.at, updatedAt: rec.updatedAt, role: rec.role, text: rec.text, transient: !shown(rec.ref.deref(), false) });
      }
      var outBatches = [];
      for (var j = 0; j < batches.length; j++) {
        var b = batches[j];
        if (b.at >= sinceAt) outBatches.push([b.id, b.at, b.content, b.cosmetic]);
      }
      return { token: token, now: Date.now(), live: outLive, batches: outBatches, droppedAt: lastDroppedAt, liveDroppedAt: liveDroppedAt };
    },
    busy: busy,
    spinnerTargets: function (set) { var els = spinnerSets[set] || []; delete spinnerSets[set]; return els; },
    valueChangedAt: function (el) { return el ? valueChangedAt.get(el) || null : null; },
    /** A shadow root found through CDP: a closed one, invisible to script. */
    adoptRoot: function (root) {
      if (observed.has(root)) return false;
      observeRoot(root);
      adopt(root, null);
      return true;
    },
    sweep: function () { sweep(); return token; },
    stop: function () { observer.disconnect(); delete globalThis.__playwriterWatch; }
  };
})();`

/** FNV-1a over the template: a version that changes whenever the in-world code does. */
function sourceVersion(source: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const WATCH_SOURCE = WATCH_SOURCE_TEMPLATE.replace('__WATCH_VERSION__', sourceVersion(WATCH_SOURCE_TEMPLATE))

/** In the isolated world: `fn(_args, ...progressbars)` → when each one's value last changed (page clock), or null. */
const VALUE_CHANGED_FN = `function (_args) {
  var reader = globalThis.${READER};
  var out = [];
  for (var i = 1; i < arguments.length; i++) out.push(reader ? reader.valueChangedAt(arguments[i]) : null);
  return out;
}`

/** In the isolated world: the spinner elements of one busy() read, in its order. */
const SPINNER_TARGETS_FN = `function (args) {
  var reader = globalThis.${READER};
  return reader ? reader.spinnerTargets(args.set) : [];
}`

/** In the isolated world: for (target, hit) pairs, whether the hit node is the target or inside it (flat tree). */
const HIT_INSIDE_FN = `function (_args) {
  var out = [];
  for (var i = 1; i + 1 < arguments.length; i += 2) {
    var target = arguments[i], hit = arguments[i + 1], inside = false;
    for (var n = hit; n && target; n = n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode) {
      if (n === target) { inside = true; break; }
    }
    out.push(inside);
  }
  return out;
}`

/** In the isolated world: start observing shadow roots found through CDP. */
const ADOPT_ROOTS_FN = `function (_args) {
  var reader = globalThis.${READER};
  if (!reader) return -1;
  var adopted = 0;
  for (var i = 1; i < arguments.length; i++) if (arguments[i] && reader.adoptRoot(arguments[i])) adopted++;
  return adopted;
}`

/** Content state of the page: every frame's journal combined. */
interface ContentState {
  /** Page clock when read. */
  now: number
  /** When the newest journal was installed: none can vouch for the content before its install. */
  installedAt: number
  /** Newest content change that counts for quiet (ambient regions and pre-action churners excluded), page clock. */
  lastContentAt: number | null
  hot: string | null
  ambient: string[]
  content: number
  cosmetic: number
}

/** One frame journal's state. */
interface WorldState extends ContentState {
  token: string
}

interface WorldLive {
  id: number
  at: number
  updatedAt: number | null
  role: string
  text: string
  transient: boolean
}

interface WorldRead {
  token: string
  now: number
  live: WorldLive[]
  /** [id, at, content, cosmetic] per MutationObserver callback. */
  batches: Array<[number, number, number, number]>
  /** Time of the newest mutation batch the in-page ring dropped, or null. */
  droppedAt: number | null
  /** Time of the newest live record the in-page ring dropped, or null. */
  liveDroppedAt: number | null
}

interface WorldSpinner {
  label: string
  /** When the animation started, page clock. */
  startedAt: number
  /** Centre of its on-screen part, viewport CSS pixels. */
  x: number
  y: number
}

interface WorldBusy {
  streaming: string | null
  announced: string[]
  spinners: { set: number; list: WorldSpinner[] }
}

/** What this module keeps per frame document once read, so a navigation does not erase what the old document showed. */
interface DocumentJournal {
  frameId: string
  /** The iframe's URL when its document was first read; null for the main frame. */
  frameUrl: string | null
  live: Map<number, WorldLive & { seq: number }>
  batches: Map<number, { at: number; content: number; cosmetic: number }>
  /** Backend ids of the shadow roots already handed to this document's journal. */
  adoptedRoots: Set<number>
  /** Newest entry each in-page ring dropped (page clock): a checkpoint at or before it reads a lower bound. */
  droppedAt: { live: number | null; mutations: number | null }
}

/**
 * Whose code runs in an execution context: the page's own — the main frame's main world (no
 * `frame`), the main world of the iframe whose document URL is `frame`, or the dedicated worker
 * whose script is `worker` —, or null for any other world (an isolated world such as ours or
 * Playwright's, an extension's content script).
 */
type ContextOwner = { frame?: string; worker?: string } | null

/**
 * A followed session: the page's own, an out-of-process iframe's or a dedicated worker's. Context
 * and WebSocket ids are per session; request ids are not (see `PageWatch.requestsById`).
 */
interface SessionWatch {
  /** What commands go through: Playwright's session, borrowed (a worker's: its server session). */
  cdp: ICDPSession
  /** Where an iframe's or a worker's events come from, from its first one; null for the page's own session, whose events `cdp` carries. */
  tapped: TappedSession | null
  /** The out-of-process iframe whose session this is; null for the page's own session and a worker's. */
  rootFrame: Frame | null
  /** The script address of the dedicated worker whose session this is; null for a document's session. */
  worker: string | null
  /** WebSocket request id → its URL, from Network.webSocketCreated. */
  socketUrls: Map<string, string>
  /** Execution context id → whose code runs in it. */
  contexts: Map<number, Promise<ContextOwner>>
  off: Array<() => void>
}

/** A journaled request. Its start is the browser's stamp, converted to this process's clock when it is compared or shown. */
interface RequestEntry extends Omit<NetworkRecord, 'startedAt'> {
  /**
   * The session that last reported it, which holds its response body. A cross-site iframe's document
   * is announced on the parent's session and its body arrives, and it ends, on the iframe's own.
   */
  session: SessionWatch
  mimeType?: string
  isAdRelated?: boolean
  /** When the renderer issued it: Chrome's `wallTime`, browser clock (epoch ms). */
  issuedAt: number
  /** `issuedAt` of the first hop of this redirect chain: causality belongs to the chain, not the hop. */
  chainIssuedAt: number
  /** Response headers arrived (this process's clock). */
  headersAt?: number
  /** Last body bytes arrived (this process's clock). */
  lastDataAt?: number
  /** Id of the hop this one was redirected to. */
  redirectedTo?: string
  /** The frame Chrome said it is for (a navigation's: the frame navigating). */
  frameId?: string
}

/** The page's dialog state machine (DialogController); PageWatch only reads it. */
export interface WatchDialogs {
  /** The open dialog, whoever answers it, or null. */
  current(): JsDialogState | null
  history(): JsDialogState[]
  /** Called synchronously whenever a dialog opens, closes or changes who answers it. */
  onChange(listener: (state: JsDialogState | null) => void): () => void
}

interface DialogEntry {
  /** Last state the controller reported for it; its final outcome is read from the controller's history. */
  state: JsDialogState
  openedSeq: number
  closedSeq?: number
}

interface ConsoleEntry {
  record: ConsoleRecord
  /** Resolves once the context is known: whose code logged it. */
  owner: Promise<ContextOwner>
}

export interface SettleOptions {
  /** The checkpoint taken right before the action's first input: requests started after it are the action's. */
  since?: WatchCheckpoint
  /** Epoch ms when the last dispatched input ended; quiet windows are measured from here. Default: now. */
  origin?: number
  timeoutMs?: number
  domQuietMs?: number
  networkQuietMs?: number
}

export interface IdleOptions {
  /** The last dispatched action's checkpoint: what was already running before it is ambient, not "still working". */
  since?: WatchCheckpoint
  /** Epoch ms when the last dispatched input ended; quiet windows are measured from here. Default: now. */
  origin?: number
  timeoutMs?: number
  quietMs?: number
  networkQuietMs?: number
}

export interface BusyOptions {
  /**
   * The last dispatched action's checkpoint. With it, an endless animation already running
   * before it is weak and a determinate progressbar is strong only if it advanced after it.
   * Without it, every endless animation on screen is a strong spinner and determinate bars are weak.
   */
  since?: WatchCheckpoint
}

interface QuietGoal {
  timeoutMs: number
  domQuietMs: number
  networkQuietMs: number
  origin: number
  /** Requests started at/after this are the action's own. */
  causalFrom: number
  /** Churn and animations that predate this are ambient. */
  since?: WatchCheckpoint
  /** waitForIdle: also require no strong busy signal. */
  needIdle: boolean
}

type Raced<T> = { value: T } | { dialog: true }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Console arguments as DevTools prints them. Objects arrive by reference (no `value`),
 * with a shallow `preview` that Runtime.enable attaches — formatting it gives
 * `{code: 500}` instead of the useless description `Object`.
 */
function formatRemoteObject(o: Protocol.Runtime.RemoteObject): string {
  if (o.type === 'string') return String(o.value)
  if (o.type === 'object' && o.preview && (o.subtype === undefined || o.subtype === 'array')) {
    const preview = o.preview
    const items = preview.properties.map((p) => {
      const value = p.type === 'string' ? JSON.stringify(p.value ?? '') : (p.value ?? p.subtype ?? p.type)
      return preview.subtype === 'array' ? value : `${p.name}: ${value}`
    })
    if (preview.overflow) items.push('…')
    return preview.subtype === 'array' ? `[${items.join(', ')}]` : `{${items.join(', ')}}`
  }
  if ('value' in o && o.value !== undefined) {
    return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value)
  }
  if (o.unserializableValue) return o.unserializableValue
  if (o.description) return o.description
  return o.type
}

function formatLocation(url: string | undefined, line: number | undefined, column: number | undefined): string | undefined {
  if (!url) return undefined
  return `${url}:${(line ?? 0) + 1}:${(column ?? 0) + 1}`
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The record the model reads: its start on this process's clock. */
function publicRecord(entry: RequestEntry, clock: BrowserClock): NetworkRecord {
  const {
    session: _session,
    mimeType: _mimeType,
    isAdRelated: _isAdRelated,
    issuedAt,
    chainIssuedAt: _chainIssuedAt,
    headersAt: _headersAt,
    lastDataAt: _lastDataAt,
    redirectedTo: _redirectedTo,
    frameId: _frameId,
    ...record
  } = entry
  return { ...record, startedAt: Math.round(clock.toLocal(issuedAt)) }
}

function isFailed(entry: Pick<NetworkRecord, 'failed' | 'status'>): boolean {
  return entry.failed !== undefined || (entry.status !== undefined && entry.status >= 400)
}

/**
 * Why Chrome says a request failed. Its `errorText` is empty for a request it blocked (measured:
 * GitHub's fetch whose cross-origin redirect the page's CSP refused came with `errorText: ""` and
 * `blockedReason: "csp"`); the block or CORS reason it gave is the reason then.
 */
function failureOf(e: Protocol.Network.LoadingFailedEvent): string {
  if (e.canceled) return 'canceled'
  if (e.errorText) return e.errorText
  if (e.blockedReason) return `blocked: ${e.blockedReason}`
  if (e.corsErrorStatus) return `CORS error: ${e.corsErrorStatus.corsError}${e.corsErrorStatus.failedParameter ? ` (${e.corsErrorStatus.failedParameter})` : ''}`
  return 'failed; Chrome gave no reason'
}

function axProperty(node: Protocol.Accessibility.AXNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value?.value
}

/**
 * `role "name"`; a node without a name (a status, a region) is labelled by the text it shows,
 * gathered from its StaticText descendants, which is what a person reads there.
 */
function axLabel(node: Protocol.Accessibility.AXNode, byId: Map<string, Protocol.Accessibility.AXNode>): string {
  const role = typeof node.role?.value === 'string' ? node.role.value : 'element'
  let text = typeof node.name?.value === 'string' ? node.name.value.trim() : ''
  const pending = text ? [] : [...(node.childIds ?? [])].reverse()
  while (pending.length > 0 && text.length <= 60) {
    const child = byId.get(pending.pop()!)
    if (!child || child.ignored) continue
    if (child.role?.value === 'StaticText' && typeof child.name?.value === 'string') text = `${text} ${child.name.value}`.replace(/\s+/g, ' ').trim()
    pending.push(...[...(child.childIds ?? [])].reverse())
  }
  return text ? `${role} "${clipText(text, 60)}"` : role
}

/** `progressbar "Upload" 45%` / `… "step 2: copying"`, from the AX node. */
function progressLabel(node: Protocol.Accessibility.AXNode, value: number, byId: Map<string, Protocol.Accessibility.AXNode>): string {
  const label = axLabel(node, byId)
  const text = axProperty(node, 'valuetext')
  if (typeof text === 'string' && text.trim() !== '') return `${label} "${clipText(text.trim(), 60)}"`
  const min = axProperty(node, 'valuemin')
  const max = axProperty(node, 'valuemax')
  if (typeof min === 'number' && typeof max === 'number' && max > min) return `${label} ${Math.round(((value - min) / (max - min)) * 100)}%`
  return `${label} ${value}`
}

/** Bytes of a WebSocket payload: text frames (opcode 1) are UTF-8, every other opcode is base64. */
function payloadBytes(frame: Protocol.Network.WebSocketFrame): number {
  return frame.opcode === 1 ? Buffer.byteLength(frame.payloadData, 'utf8') : Buffer.from(frame.payloadData, 'base64').length
}

export class PageWatch {
  private readonly frames: PageFrames
  /** The page's own session: navigations, the main document and every same-process iframe. */
  private readonly cdp: ICDPSession
  private readonly isClosed?: () => boolean
  private readonly dialogs: WatchDialogs
  private readonly logger: { error: (...args: unknown[]) => void }
  /** The browser's clock against this process's: every browser stamp is compared through it. */
  private readonly clock = new BrowserClock()
  private readonly openSessionTap: (onWorker: (worker: TappedWorker) => void) => SessionTap
  /** Out-of-process iframes' and workers' sessions, held from their first event in Playwright's server; set by start(). */
  private tap: SessionTap | null = null

  private started = false
  private seq = 0
  private requestCounter = 0
  /** Listeners that are not on a followed session: frame changes, dialogs, the page's navigations. */
  private readonly unlisten: Array<() => void> = []
  /** Every session whose network and console are journaled: the page's own, each out-of-process iframe's and each worker's. */
  private readonly sessions = new Set<SessionWatch>()
  /** Out-of-process iframe id → the watch of its session. */
  private readonly oopifSessions = new Map<string, SessionWatch>()
  /** Frame id → the work following its changes, chained so a frame's attach, navigations and removal are handled in order. */
  private readonly frameWork = new Map<string, Promise<void>>()
  private readonly requestLog: RequestEntry[] = []
  /**
   * Chrome's request id → the latest hop of that request, across all the page's sessions. The id is
   * unique in the browser (a document's is its loader id, a subresource's carries its renderer
   * process), and one request can be reported on two sessions: a cross-site iframe's document is
   * announced (requestWillBeSent, responseReceived) on the parent's session, and its data and its end
   * on the iframe's own session once the new renderer commits it (measured).
   */
  private readonly requestsById = new Map<string, RequestEntry>()
  private readonly consoleLog: ConsoleEntry[] = []
  private readonly navigationLog: NavigationRecord[] = []
  private readonly dialogLog: DialogEntry[] = []
  private readonly socketLog: Array<WebSocketFrameRecord & { seq: number }> = []
  /** Highest seq each capped journal dropped: a checkpoint below it reads an incomplete list. */
  private readonly droppedSeq = { network: 0, console: 0, navigations: 0, webSockets: 0 }
  /** loaderId → Chrome's navigation type, from Page.frameStartedNavigating of the main frame. */
  private readonly startedNavigations = new Map<string, string>()
  /** Every frame document's journal as read, by frame id and in-page journal token. */
  private readonly documents = new Map<string, DocumentJournal>()
  /** Frame id → the journal of the document it shows now. */
  private readonly currentDocuments = new Map<string, DocumentJournal>()
  private mainDocumentId: string | null = null
  private currentUrl: string | null = null
  private mainFrameLoading = false
  /** Woken on a dialog change, a navigation commit or the main frame finishing loading. */
  private readonly wakers = new Set<() => void>()
  /** Woken on every dialog change. */
  private readonly dialogWaiters = new Set<() => void>()

  constructor(options: {
    frames: PageFrames
    dialogs: WatchDialogs
    isClosed?: () => boolean
    logger?: { error: (...args: unknown[]) => void }
    /** Where out-of-process iframes' and workers' sessions come from; Playwright's in-process server by default (`session-tap.ts`). */
    openSessionTap?: (onWorker: (worker: TappedWorker) => void) => SessionTap
  }) {
    this.frames = options.frames
    this.cdp = options.frames.cdp
    this.dialogs = options.dialogs
    this.isClosed = options.isClosed
    this.logger = options.logger ?? console
    this.openSessionTap =
      options.openSessionTap ??
      ((onWorker) =>
        new PageSessionTap({ page: this.frames.page, onWorker, onError: (error) => this.reportBackgroundError('following a new iframe’s or worker’s session', error) }))
  }

  /** Attach CDP listeners and install the in-page journal in every frame. Idempotent; returns immediately. */
  start(): void {
    if (this.started) return
    // First: an iframe or worker whose session is created from here on is held from its first event.
    // The workers that already run are handed over at once.
    this.tap = this.openSessionTap((worker) => this.followWorker(worker))
    this.started = true
    this.frames.addSetup(SETUP_NAME, WATCH_SOURCE)

    this.watchSession(this.cdp, null, null, null)
    this.listenPage('Page.frameStartedNavigating', (e) => {
      if (e.frameId !== this.frames.mainFrameId() || SAME_DOCUMENT_NAVIGATIONS[e.navigationType]) return
      this.startedNavigations.set(e.loaderId, e.navigationType)
    })
    this.listenPage('Page.frameNavigated', (e) => this.onFrameNavigated(e))
    this.listenPage('Page.navigatedWithinDocument', (e) => {
      if (e.frameId !== this.frames.mainFrameId()) return
      this.currentUrl = e.url
      this.pushNavigation('same-document', e.url, e.navigationType)
    })
    this.listenPage('Page.frameStartedLoading', (e) => {
      if (e.frameId !== this.frames.mainFrameId()) return
      this.mainFrameLoading = true
      this.readBeforeLeaving()
    })
    this.listenPage('Page.frameStoppedLoading', (e) => {
      if (e.frameId !== this.frames.mainFrameId()) return
      this.mainFrameLoading = false
      this.wake()
    })
    this.listenPage('Page.loadEventFired', () => {
      this.mainFrameLoading = false
      this.wake()
    })
    this.unlisten.push(this.frames.onChange((change) => this.queueFrame(change.frameId, () => this.followFrame(change.frameId, change.kind))))
    this.unlisten.push(this.dialogs.onChange((state) => this.onDialogChange(state)))

    void this.frames
      .list()
      .then(async ({ frames }) => {
        for (const entry of frames) {
          if (entry.outOfProcess) this.queueFrame(entry.frameId, () => this.followFrame(entry.frameId, 'listed'))
        }
        await this.installJournals(frames)
      })
      .catch((error) => this.reportBackgroundError('installing the page journal', error))
    void withDeadline(this.cdp.send('Page.getFrameTree'), PROBE_TIMEOUT_MS, 'reading the frame tree')
      .then(({ frameTree }) => {
        if (this.mainDocumentId === null) this.mainDocumentId = frameTree.frame.loaderId
        if (this.currentUrl === null) this.currentUrl = frameTree.frame.url + (frameTree.frame.urlFragment ?? '')
      })
      .catch((error) => this.reportBackgroundError('reading the main document id', error))
  }

  dispose(): void {
    for (const off of this.unlisten.splice(0)) off()
    for (const session of this.sessions.values()) {
      for (const off of session.off.splice(0)) off()
    }
    this.sessions.clear()
    this.oopifSessions.clear()
    this.tap?.dispose()
    this.tap = null
    if (this.started) {
      // Future copies of the frames' worlds get no journal; the current copies stop observing.
      this.frames.addSetup(SETUP_NAME, 'void 0')
      if (!this.dialogs.current() && !this.isClosed?.()) {
        void this.frames
          .list()
          .then(({ frames }) =>
            Promise.all(
              frames.map((entry) =>
                entry.world.evaluate(`globalThis.${READER} && globalThis.${READER}.stop()`, { timeoutMs: PROBE_TIMEOUT_MS, what: 'stopping the page journal' }),
              ),
            ),
          )
          .catch(() => {})
      }
    }
    this.started = false
    this.wake()
  }

  checkpoint(): WatchCheckpoint {
    return { seq: this.seq, at: Date.now() }
  }

  /**
   * Everything that happened after `checkpoint`, in every frame. While a native dialog is open
   * the page is frozen and its journals cannot be read; the in-page part then holds what was
   * read before (the frozen page cannot have changed since its MutationObservers last ran).
   */
  async since(checkpoint: WatchCheckpoint): Promise<WatchEvents> {
    if (!this.dialogs.current() && !this.isClosed?.()) {
      try {
        await this.unlessDialog(this.readJournal(checkpoint.at, PROBE_TIMEOUT_MS))
      } catch (error) {
        if (!this.dialogs.current() && !this.isClosed?.()) throw error
      }
    }
    const network = this.requestLog.filter((r) => r.seq > checkpoint.seq).map((r) => publicRecord(r, this.clock))
    const live: LiveTextRecord[] = []
    const mutations = { content: 0, cosmetic: 0 }
    const dropped = new Set<NonNullable<WatchEvents['dropped']>[number]>()
    for (const doc of this.documents.values()) {
      // The in-page journal stamps with the browser's clock (a document is only known from a read, which measured it).
      const at = this.clock.toBrowser(checkpoint.at)
      const current = this.currentDocuments.get(doc.frameId) === doc
      for (const rec of doc.live.values()) {
        if (rec.at < at && (rec.updatedAt === null || rec.updatedAt < at)) continue
        const transient = rec.transient || !current
        live.push({
          seq: rec.seq,
          at: Math.round(this.clock.toLocal(rec.at)),
          role: rec.role,
          text: rec.text,
          ...(transient ? { transient: true } : {}),
          ...(doc.frameUrl !== null ? { frame: doc.frameUrl } : {}),
        })
      }
      for (const batch of doc.batches.values()) {
        if (batch.at < at) continue
        mutations.content += batch.content
        mutations.cosmetic += batch.cosmetic
      }
      if (doc.droppedAt.live !== null && doc.droppedAt.live >= at) dropped.add('live')
      if (doc.droppedAt.mutations !== null && doc.droppedAt.mutations >= at) dropped.add('mutations')
    }
    live.sort((a, b) => a.at - b.at || a.seq - b.seq)
    const console = await this.ownConsole(checkpoint.seq)
    for (const journal of ['network', 'console', 'navigations', 'webSockets'] as const) {
      if (this.droppedSeq[journal] > checkpoint.seq) dropped.add(journal)
    }
    const history = this.dialogs.history()
    return {
      network,
      failedRequests: network.filter(isFailed),
      console,
      navigations: this.navigationLog.filter((r) => r.seq > checkpoint.seq).map((r) => ({ ...r })),
      dialogs: this.dialogLog
        .filter((d) => d.openedSeq > checkpoint.seq || (d.closedSeq ?? 0) > checkpoint.seq)
        .map((d) => ({ ...(history.findLast((h) => h.openedAt === d.state.openedAt && h.message === d.state.message && h.type === d.state.type) ?? d.state) })),
      live,
      mutations,
      webSockets: this.socketLog.filter((f) => f.seq > checkpoint.seq).map(({ seq: _seq, ...frame }) => frame),
      ...(dropped.size > 0 ? { dropped: [...dropped] } : {}),
    }
  }

  /**
   * What on the page says "still working, wait", read-only, in every frame: the accessibility
   * tree (busy, progressbars), endless animations that are on screen and on top, the in-page
   * journals (content still streaming, announcements since `since`), and the request journal
   * (response bodies still arriving, requests the server holds). Signals inside an iframe name
   * it. Waits out a dialog the policy answers by itself; throws while one waits for the agent —
   * the frozen page cannot be read, and pretending it shows nothing busy would be a lie.
   */
  async busySignals(options: BusyOptions = {}): Promise<BusySignal[]> {
    await this.waitOutAutoDialog('reading busy signals')
    // Compared in the page with the journal's stamps: on the browser's clock.
    const sinceAt = options.since ? await this.onBrowserClock(options.since.at) : null
    const perFrame = await this.eachFrame(await this.readableFrames(), (entry) => this.frameBusySignals(entry, sinceAt))
    const out = perFrame.flatMap(({ value }) => value)
    out.push(...this.networkBusy())
    return out
  }

  /**
   * Wait until the page has finished reacting to the action: content quiet for `domQuietMs`
   * in every frame and the requests the action caused (any frame's) quiet for
   * `networkQuietMs`, both measured from `origin` (the end of the last input; default now).
   * Requests that started before `since` (or before `origin` without it) are reported in
   * `uncaused`, never waited on. A dialog the agent must answer returns `js-dialog` at once;
   * one the policy answers is waited out and the quiet windows start again after it closed. A
   * cross-document navigation in progress is waited for first and the new document is
   * measured afresh.
   */
  async settle(options: SettleOptions = {}): Promise<SettleResult> {
    const origin = options.origin ?? Date.now()
    return await this.waitQuiet({
      timeoutMs: options.timeoutMs ?? 5000,
      domQuietMs: options.domQuietMs ?? 300,
      networkQuietMs: options.networkQuietMs ?? 500,
      origin,
      causalFrom: options.since?.at ?? origin,
      since: options.since,
      needIdle: false,
    })
  }

  /**
   * Like settle, with windows long enough to span the pauses between streamed chunks, and
   * additionally no STRONG busy signal (aria-busy, an indeterminate or advancing progressbar,
   * a spinner on screen, content still streaming, a response body still arriving). Use
   * before reading an AI reply.
   */
  async waitForIdle(options: IdleOptions = {}): Promise<SettleResult> {
    const origin = options.origin ?? Date.now()
    return await this.waitQuiet({
      timeoutMs: options.timeoutMs ?? 60000,
      domQuietMs: options.quietMs ?? 1500,
      networkQuietMs: options.networkQuietMs ?? 1000,
      origin,
      causalFrom: options.since?.at ?? origin,
      since: options.since,
      needIdle: true,
    })
  }

  requests(filter: { urlIncludes?: string; method?: string; failedOnly?: boolean; limit?: number } = {}): NetworkRecord[] {
    const method = filter.method?.toUpperCase()
    const matches = this.requestLog.filter(
      (r) =>
        (!filter.urlIncludes || r.url.includes(filter.urlIncludes)) &&
        (!method || r.method.toUpperCase() === method) &&
        (!filter.failedOnly || isFailed(r)),
    )
    const limited = filter.limit !== undefined && filter.limit >= 0 ? matches.slice(Math.max(0, matches.length - filter.limit)) : matches
    return limited.map((r) => publicRecord(r, this.clock))
  }

  /** Response body of a journaled request (Network.getResponseBody on the session that reported it), textual bodies decoded, capped at 64K chars. */
  async responseBody(id: string): Promise<{ status?: number; mimeType?: string; body: string; truncated: boolean; base64Encoded: boolean }> {
    const { entry, result } = await this.fetchResponseBody(id)
    let body = result.body
    let base64Encoded = result.base64Encoded
    const mime = entry.mimeType?.split(';', 1)[0]!.trim()
    if (base64Encoded && mime && TEXTUAL_MIME_RE.test(mime)) {
      body = Buffer.from(body, 'base64').toString('utf8')
      base64Encoded = false
    }
    const truncated = body.length > BODY_CAP_CHARS
    return {
      status: entry.status,
      mimeType: entry.mimeType,
      body: truncated ? body.slice(0, BODY_CAP_CHARS) : body,
      truncated,
      base64Encoded,
    }
  }

  /** The whole response body of a journaled request as bytes, uncapped: net.save writes it to a file. Throws responseBody's reasons when there is none. */
  async responseBytes(id: string): Promise<{ status?: number; mimeType?: string; bytes: Buffer }> {
    const { entry, result } = await this.fetchResponseBody(id)
    return { status: entry.status, mimeType: entry.mimeType, bytes: Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8') }
  }

  /** The journal entry for `id` and Chrome's body for it (Network.getResponseBody on the session that reported it), or the precise reason there is none. */
  private async fetchResponseBody(id: string): Promise<{ entry: RequestEntry; result: Protocol.Network.GetResponseBodyResponse }> {
    const entry = this.requestLog.find((r) => r.id === id)
    if (!entry) {
      throw new Error(`No request ${id} in the journal. Ids come from requests(); the journal keeps the last ${REQUEST_CAP} requests of this page.`)
    }
    if (entry.redirectedTo !== undefined) {
      const answer = entry.status !== undefined ? `answered with a redirect (HTTP ${entry.status})` : 'redirected (Chrome did not report the redirect response)'
      throw new Error(`Request ${id} (${entry.method} ${entry.url}) was ${answer} to ${entry.redirectedTo}; a redirect has no body. Read ${entry.redirectedTo}.`)
    }
    if (entry.download !== undefined) {
      throw new Error(
        `Request ${id} (${entry.method} ${entry.url}) became the download "${entry.download}": its body went to the download, not to the page. The report's DOWNLOAD line names it; downloads.save saves it.`,
      )
    }
    if (entry.endedAt === undefined) {
      throw new Error(`Request ${id} (${entry.method} ${entry.url}) has not finished yet; its body is available once it has.`)
    }
    if (entry.lost !== undefined) {
      throw new Error(`Request ${id} (${entry.method} ${entry.url}) has no body to read: Chrome stopped reporting it before it finished (${entry.lost}).`)
    }
    if (entry.failed !== undefined && entry.status === undefined) {
      throw new Error(`Request ${id} (${entry.method} ${entry.url}) failed (${entry.failed}) before any response; there is no body.`)
    }
    try {
      const result = await withDeadline(
        entry.session.cdp.send('Network.getResponseBody', { requestId: entry.requestId }),
        PROBE_TIMEOUT_MS,
        `reading the response body of ${id}`,
      )
      return { entry, result }
    } catch (error) {
      if (error instanceof PageUnresponsiveError) throw error
      throw new Error(
        `Chrome has no body for request ${id} (${entry.method} ${entry.url}): ${errorMessage(error)}. ` +
          'Bodies are dropped when the page (or the iframe that sent the request) navigates away or is closed, or when Chrome evicts its network buffer.',
      )
    }
  }

  navigations(): NavigationRecord[] {
    return this.navigationLog.map((r) => ({ ...r }))
  }

  /** Main-frame loaderId as last seen; a different value means a new document (every client cache gone). */
  documentId(): string | null {
    return this.mainDocumentId
  }

  // ---------------------------------------------------------------------------
  // settle
  // ---------------------------------------------------------------------------

  private async waitQuiet(goal: QuietGoal): Promise<SettleResult> {
    const startedAt = Date.now()
    const deadline = startedAt + goal.timeoutMs
    // Endpoints that were already open when the action began: a re-poll of one is the page's
    // background channel reconnecting, not the action's effect.
    const openAtStart = new Set(
      this.requestLog
        .filter((r) => this.clock.toLocal(r.chainIssuedAt) < goal.causalFrom && (r.endedAt ?? Infinity) >= goal.causalFrom)
        .map((r) => `${r.method} ${r.url}`),
    )
    let origin = goal.origin
    let rootsLookedAt = 0
    // A busy read walks the whole accessibility tree; the next poll waits at least as long as it took.
    let busyReadMs = 0
    for (;;) {
      const blocked = this.blockedResult(startedAt, goal, openAtStart)
      if (blocked) return blocked
      if (this.dialogs.current()) {
        // The policy answers this one by itself; the page is frozen until it closes and then
        // resumes running, so the quiet windows start again from the close.
        await this.untilDialogChange(deadline)
        if (!this.dialogs.current()) origin = Math.max(origin, Date.now())
      } else if (!this.mainFrameLoading) {
        let state: ContentState | undefined
        try {
          if (Date.now() - rootsLookedAt >= ROOT_DISCOVERY_MS) {
            const discovered = await this.unlessDialog(this.readableFrames().then((entries) => this.discoverShadowRoots(entries)))
            if ('dialog' in discovered) continue
            rootsLookedAt = Date.now()
          }
          const raced = await this.unlessDialog(this.readState(goal.since?.at ?? null, null, PROBE_TIMEOUT_MS))
          if ('dialog' in raced) continue
          state = raced.value
        } catch (error) {
          const ended = this.endedResult(startedAt, error)
          if (ended) return ended
          // A document was replaced between the loading check and the read: measure the new one next round.
          if (!DEAD_CONTEXT_RE.test(errorMessage(error))) throw error
        }
        if (state) {
          const now = Date.now()
          const domQuietFor = Math.min(now - origin, msSinceContent(state))
          if (domQuietFor >= goal.domQuietMs && this.networkQuietFor(now, origin, goal.causalFrom, openAtStart) >= goal.networkQuietMs) {
            const busyReadStart = Date.now()
            const busy = await this.unlessDialog(this.busySignals({ since: goal.since }))
            if ('dialog' in busy) continue
            busyReadMs = Date.now() - busyReadStart
            if (!goal.needIdle || !busy.value.some((s) => s.strength === 'strong')) {
              const ambient = await this.unlessDialog(this.readState(goal.since?.at ?? null, origin, PROBE_TIMEOUT_MS))
              if ('dialog' in ambient) continue
              const uncaused = this.uncausedRequests(now, goal.causalFrom, openAtStart)
              return {
                settled: true,
                waitedMs: Date.now() - startedAt,
                reason: 'quiet',
                pendingRequests: [],
                ...(uncaused.length ? { uncaused } : {}),
                ...(ambient.value.ambient.length ? { ambient: ambient.value.ambient } : {}),
                ...(state.lastContentAt !== null ? { msSinceLastContentMutation: state.now - state.lastContentAt } : {}),
                busy: busy.value,
              }
            }
          }
        }
      }
      if (Date.now() >= deadline) return await this.timeoutResult(startedAt, goal, origin, openAtStart)
      await this.pause(Math.min(Math.max(POLL_MS, busyReadMs), Math.max(0, deadline - Date.now())))
      busyReadMs = 0
    }
  }

  private async timeoutResult(startedAt: number, goal: QuietGoal, origin: number, openAtStart: Set<string>): Promise<SettleResult> {
    let state: ContentState | undefined
    let busy: BusySignal[]
    try {
      if (this.mainFrameLoading || this.dialogs.current()) {
        // The old document is being replaced, or a dialog the policy answers froze it: only the network side is readable.
        busy = this.networkBusy()
      } else {
        const raced = await this.unlessDialog(this.readState(goal.since?.at ?? null, origin, PROBE_TIMEOUT_MS, true))
        if ('dialog' in raced) return this.blockedResult(startedAt, goal, openAtStart) ?? (await this.timeoutResult(startedAt, goal, origin, openAtStart))
        state = raced.value
        const signals = await this.unlessDialog(this.busySignals({ since: goal.since }))
        if ('dialog' in signals) return this.blockedResult(startedAt, goal, openAtStart) ?? (await this.timeoutResult(startedAt, goal, origin, openAtStart))
        busy = signals.value
      }
    } catch (error) {
      const ended = this.endedResult(startedAt, error)
      if (ended) return ended
      throw error
    }
    const now = Date.now()
    const msSince = state && state.lastContentAt !== null ? state.now - state.lastContentAt : undefined
    const stillChanging = state !== undefined && msSinceContent(state) < goal.domQuietMs
    const uncaused = this.uncausedRequests(now, goal.causalFrom, openAtStart)
    return {
      settled: false,
      waitedMs: now - startedAt,
      reason: 'timeout',
      pendingRequests: this.heldRequests(now, goal.causalFrom, openAtStart).map((r) => this.pending(r, now)),
      ...(uncaused.length ? { uncaused } : {}),
      ...(state && state.ambient.length ? { ambient: state.ambient } : {}),
      ...(stillChanging && state?.hot ? { domChangingIn: state.hot } : {}),
      ...(msSince !== undefined ? { msSinceLastContentMutation: msSince } : {}),
      busy,
    }
  }

  /** page-closed / js-dialog results, checked before every probe so a frozen page is never probed. */
  private blockedResult(startedAt: number, goal: QuietGoal, openAtStart: Set<string>): SettleResult | null {
    if (this.isClosed?.()) {
      return { settled: false, waitedMs: Date.now() - startedAt, reason: 'page-closed', pendingRequests: [], busy: [] }
    }
    const dialog = this.dialogs.current()
    if (dialog?.handling === 'agent') {
      const now = Date.now()
      return {
        settled: false,
        waitedMs: now - startedAt,
        reason: 'js-dialog',
        pendingRequests: this.heldRequests(now, goal.causalFrom, openAtStart).map((r) => this.pending(r, now)),
        busy: [],
        dialog,
      }
    }
    return null
  }

  /** A probe failed: if the page closed meanwhile, that is the answer. */
  private endedResult(startedAt: number, error: unknown): SettleResult | null {
    // Without an isClosed callback, the protocol's own "target closed" wording is the evidence.
    const closed = this.isClosed ? this.isClosed() : CLOSED_RE.test(errorMessage(error))
    if (closed) {
      return { settled: false, waitedMs: Date.now() - startedAt, reason: 'page-closed', pendingRequests: [], busy: [] }
    }
    return null
  }

  /** The action's own requests: the chain started at/after `causalFrom`, and not a re-poll of an endpoint already open then. */
  private caused(entry: RequestEntry, causalFrom: number, openAtStart: Set<string>): boolean {
    return this.clock.toLocal(entry.chainIssuedAt) >= causalFrom && !openAtStart.has(`${entry.method} ${entry.url}`)
  }

  /** When the renderer issued `entry`, on this process's clock. */
  private startOf(entry: RequestEntry): number {
    return this.clock.toLocal(entry.issuedAt)
  }

  /** Whether an open request is one a person would wait on, from Chrome's own facts about it. */
  private holdsQuiet(entry: RequestEntry, now: number): boolean {
    if (entry.endedAt !== undefined || entry.isAdRelated) return false
    const type = entry.resourceType
    if (type !== undefined && NEVER_HOLDS[type]) return false
    if (entry.mimeType === EVENT_STREAM_MIME) return false
    if (type !== undefined && STALLABLE[type] && now - (entry.lastDataAt ?? this.startOf(entry)) > STALLED_ASSET_MS) return false
    return true
  }

  private heldRequests(now: number, causalFrom: number, openAtStart: Set<string>): RequestEntry[] {
    return this.requestLog.filter((r) => this.holdsQuiet(r, now) && this.caused(r, causalFrom, openAtStart))
  }

  /** Open requests that would hold quiet had the action caused them. */
  private uncausedRequests(now: number, causalFrom: number, openAtStart: Set<string>): PendingRequest[] {
    return this.requestLog.filter((r) => this.holdsQuiet(r, now) && !this.caused(r, causalFrom, openAtStart)).map((r) => this.pending(r, now))
  }

  private pending(entry: RequestEntry, now: number): PendingRequest {
    return { method: entry.method, url: entry.url, ...(entry.resourceType !== undefined ? { resourceType: entry.resourceType } : {}), ageMs: Math.round(now - this.startOf(entry)) }
  }

  private networkQuietFor(now: number, origin: number, causalFrom: number, openAtStart: Set<string>): number {
    let last = origin
    for (const r of this.requestLog) {
      if (!this.caused(r, causalFrom, openAtStart)) continue
      if (this.holdsQuiet(r, now)) return 0
      if (r.isAdRelated || (r.resourceType !== undefined && NEVER_HOLDS[r.resourceType])) continue
      last = Math.max(last, this.startOf(r), r.endedAt ?? 0)
    }
    return now - last
  }

  /** Response bodies still arriving (strong) and requests the server holds without answering (weak). */
  private networkBusy(): BusySignal[] {
    const now = Date.now()
    const out: BusySignal[] = []
    for (const r of this.requestLog) {
      if (r.endedAt !== undefined || r.isAdRelated) continue
      const age = `${((now - this.startOf(r)) / 1000).toFixed(1)}s`
      if (r.headersAt !== undefined) {
        const streamable = (r.resourceType !== undefined && STREAMABLE[r.resourceType]) || r.mimeType === EVENT_STREAM_MIME
        if (streamable && r.lastDataAt !== undefined && now - r.lastDataAt < STREAM_RECENT_MS) {
          out.push({ strength: 'strong', kind: 'network-streaming', label: `response still arriving (${age}): ${r.method} ${this.shortUrl(r.url)}` })
        }
      } else if (this.holdsQuiet(r, now) && now - this.startOf(r) > HELD_REQUEST_MS) {
        out.push({ strength: 'weak', kind: 'network-waiting', label: `no response yet after ${age}: ${r.method} ${this.shortUrl(r.url)}` })
      }
    }
    return out
  }

  /** One frame's busy signals: its accessibility tree, its journal's busy read and its spinners. `sinceAt` is on the browser's clock. */
  private async frameBusySignals(entry: FrameHandle, sinceAt: number | null): Promise<BusySignal[]> {
    const where = this.inFrame(entry)
    // A session answers for the frame it is rooted at by default; its same-process iframes are named.
    const scope = entry.frameId === entry.sessionRootId ? {} : { frameId: entry.frameId }
    const [ax, page] = await Promise.all([
      withDeadline(entry.cdp.send('Accessibility.getFullAXTree', scope), PROBE_TIMEOUT_MS, `reading the accessibility tree for busy state${where}`),
      this.callReader<WorldBusy>(entry.world, `busy(${JSON.stringify({ since: sinceAt })})`, PROBE_TIMEOUT_MS, `reading busy signals in the isolated world${where}`),
    ])
    const out: BusySignal[] = []
    const byId = new Map(ax.nodes.map((node) => [node.nodeId, node]))
    const determinate: Array<{ node: Protocol.Accessibility.AXNode; value: number; backendNodeId: number }> = []
    for (const node of ax.nodes) {
      if (node.ignored) continue
      // AX booleans arrive as `true`, `1` or `"true"` depending on the property.
      const busy = axProperty(node, 'busy')
      if (busy === true || busy === 1 || busy === 'true') {
        out.push({ strength: 'strong', kind: 'aria-busy', label: `${axLabel(node, byId)} is marked busy${where}` })
      }
      if (node.role?.value !== 'progressbar') continue
      const value = node.value?.value
      if (typeof value !== 'number') {
        out.push({ strength: 'strong', kind: 'progressbar', label: `${axLabel(node, byId)} (indeterminate)${where}` })
      } else if (node.backendDOMNodeId !== undefined) {
        determinate.push({ node, value, backendNodeId: node.backendDOMNodeId })
      } else {
        out.push({ strength: 'weak', kind: 'progressbar', label: `${progressLabel(node, value, byId)}${where}` })
      }
    }
    if (determinate.length > 0) {
      const changedAt =
        sinceAt === null
          ? determinate.map(() => null)
          : await entry.world.callFunctionOnNodes<Array<number | null>>(
              determinate.map((d) => d.backendNodeId),
              VALUE_CHANGED_FN,
              { timeoutMs: PROBE_TIMEOUT_MS, what: `reading when progressbars last moved${where}` },
            )
      determinate.forEach(({ node, value }, index) => {
        const moved = changedAt[index]
        const max = axProperty(node, 'valuemax')
        const unfinished = typeof max !== 'number' || value < max
        const advancing = sinceAt !== null && moved !== null && moved !== undefined && moved >= sinceAt && unfinished
        const state = advancing ? ' (advanced since the action)' : !unfinished ? ' (complete)' : sinceAt !== null ? ' (not moved since the action)' : ''
        out.push({ strength: advancing ? 'strong' : 'weak', kind: 'progressbar', label: `${progressLabel(node, value, byId)}${where}${state}` })
      })
    }
    out.push(...(await this.spinnerSignals(entry, page.spinners, sinceAt)))
    if (page.streaming) out.push({ strength: 'strong', kind: 'dom-streaming', label: `${page.streaming}${where}` })
    for (const text of page.announced) out.push({ strength: 'weak', kind: 'status-text', label: `${text}${where} (announced since the action)` })
    return out
  }

  /**
   * A frame's endless animations that are on screen and actually on top at their centre.
   * "On top" is Chrome's hit test at every process boundary: the frame's own session hit-tests
   * its document (descending into its same-process iframes) — only that session sees inside an
   * out-of-process frame — and must land in this frame, inside the animated element. What
   * covers an out-of-process frame is in its parent's document, which only the parent's session
   * sees, so the point is also hit-tested in the parent of each out-of-process frame around it,
   * where it must land on that frame's `<iframe>`. Points are carried between the coordinate
   * spaces through `PageFrames.box`/`sessionBox`, the frames' measured places on the screen.
   */
  private async spinnerSignals(entry: FrameHandle, spinners: WorldBusy['spinners'], sinceAt: number | null): Promise<BusySignal[]> {
    if (spinners.list.length === 0) return []
    const where = this.inFrame(entry)
    const targets = await entry.world.nodesReturnedBy([], SPINNER_TARGETS_FN, {
      args: { set: spinners.set },
      timeoutMs: PROBE_TIMEOUT_MS,
      what: `identifying animated elements${where}`,
    })
    // Spinner centres are in the frame's own viewport: `box` puts them on the screen.
    const box = entry.parentId === null ? IDENTITY_BOX : await this.frames.box(entry.frameId)
    const pairs: number[] = []
    const candidates: Array<{ spinner: WorldSpinner; pair: number; x: number; y: number }> = []
    for (const [index, spinner] of spinners.list.entries()) {
      const target = targets[index]
      if (target === null || target === undefined) continue
      const x = box.x + spinner.x * box.scale
      const y = box.y + spinner.y * box.scale
      const hit = await this.nodeAt(entry, x, y, `hit-testing the animated ${spinner.label}${where}`)
      // Nothing there, or another document on top of it (the parent's overlay, a child iframe).
      if (hit === null || hit.frameId !== entry.frameId) continue
      candidates.push({ spinner, pair: pairs.length / 2, x, y })
      pairs.push(target, hit.backendNodeId)
    }
    if (candidates.length === 0) return []
    const inside = await entry.world.callFunctionOnNodes<boolean[]>(pairs, HIT_INSIDE_FN, {
      timeoutMs: PROBE_TIMEOUT_MS,
      what: `checking which animated elements are on top${where}`,
    })
    const out: BusySignal[] = []
    for (const { spinner, pair, x, y } of candidates) {
      if (!inside[pair] || !(await this.shownThroughFrames(entry, x, y, spinner.label))) continue
      const fresh = sinceAt === null || spinner.startedAt >= sinceAt
      out.push({
        strength: fresh ? 'strong' : 'weak',
        kind: 'spinner',
        label: `${spinner.label} repeating endlessly${where}${fresh ? '' : ' (already running before the action)'}`,
      })
    }
    return out
  }

  /** Whether the screen point (x, y) in `entry` is uncovered in the parent of every out-of-process frame around it. */
  private async shownThroughFrames(entry: FrameHandle, x: number, y: number, label: string): Promise<boolean> {
    const mainFrameId = this.frames.mainFrameId()
    for (let rootId = entry.sessionRootId; rootId !== mainFrameId; ) {
      const owner = await this.frames.owner(rootId)
      const parent = await this.frames.handle(owner.parentId)
      const hit = await this.nodeAt(parent, x, y, `hit-testing the iframe around the animated ${label}`)
      if (hit === null || hit.backendNodeId !== owner.backendNodeId) return false
      rootId = parent.sessionRootId
    }
    return true
  }

  /**
   * Chrome's hit test at screen point (x, y) in the session of `handle`; null when nothing is there.
   * `DOM.getNodeForLocation` takes the point in DOCUMENT coordinates of the session's root frame
   * (Chromium maps it with DocumentToFrame): the point in that frame's viewport plus how far its
   * document is scrolled, read now in its isolated world. Measured: on a page scrolled 720px,
   * (100, 100) answers "No node found at given location" and (100, 820) the element drawn at (100, 100).
   */
  private async nodeAt(handle: FrameHandle, x: number, y: number, what: string): Promise<{ backendNodeId: number; frameId: string } | null> {
    const origin = await this.frames.sessionBox(handle)
    const root = handle.sessionRootId === handle.frameId ? handle : await this.frames.handle(handle.sessionRootId)
    const scrolled = await root.world.evaluate<{ x: number; y: number }>('({ x: scrollX, y: scrollY })', {
      timeoutMs: PROBE_TIMEOUT_MS,
      what: `reading how far the document is scrolled, ${what}`,
    })
    try {
      const location = await withDeadline(
        handle.cdp.send('DOM.getNodeForLocation', {
          x: Math.round((x - origin.x) / origin.scale + scrolled.x),
          y: Math.round((y - origin.y) / origin.scale + scrolled.y),
          includeUserAgentShadowDOM: false,
          ignorePointerEventsNone: true,
        }),
        PROBE_TIMEOUT_MS,
        what,
      )
      return { backendNodeId: location.backendNodeId, frameId: location.frameId }
    } catch (error) {
      if (NO_NODE_AT_POINT_RE.test(errorMessage(error))) return null
      throw error
    }
  }

  private shortUrl(url: string): string {
    try {
      const parsed = new URL(url)
      const sameOrigin = this.currentUrl !== null && new URL(this.currentUrl).origin === parsed.origin
      return clipText(sameOrigin ? parsed.pathname + parsed.search : url, 120)
    } catch {
      return clipText(url, 120)
    }
  }

  /**
   * ` in iframe "name"` (or its URL) to append to a label of something inside an iframe; '' in the
   * main frame. A listed frame's URL is its document's own (Playwright's `frame.url()` is '' for an
   * iframe that loaded before a relay tab was attached).
   */
  private inFrame(handle: FrameHandle | FrameEntry): string {
    if (handle.parentId === null) return ''
    const name = handle.frame.name()
    const url = 'url' in handle ? handle.url : handle.frame.url()
    return name ? ` in iframe "${clipText(name, 60)}"` : ` in iframe ${this.shortUrl(url)}`
  }

  // ---------------------------------------------------------------------------
  // in-page journals, one per frame document
  // ---------------------------------------------------------------------------

  /** The frames whose documents can be read now, main first. Throws when the main document itself cannot be read. */
  private async readableFrames(): Promise<FrameEntry[]> {
    const { frames, unreadable } = await this.frames.list()
    const main = unreadable.find((frame) => frame.parentId === null)
    if (main) throw new ModelFacingError(`The page cannot be read: ${main.reason}.`)
    return frames
  }

  /** `read` every frame, together; an iframe that went away while being read is left out, any other failure is thrown. */
  private async eachFrame<H extends FrameHandle, T>(handles: H[], read: (handle: H) => Promise<T>): Promise<Array<{ handle: H; value: T }>> {
    const results = await Promise.all(
      handles.map(async (handle): Promise<{ handle: H; value: T } | null> => {
        try {
          return { handle, value: await read(handle) }
        } catch (error) {
          if (this.frameGone(handle, error)) return null
          throw error
        }
      }),
    )
    return results.filter((result): result is { handle: H; value: T } => result !== null)
  }

  /** A read of `handle` failed because the iframe is gone: removed, or (out of process) its session closed when it left that process. */
  private frameGone(handle: FrameHandle, error: unknown): boolean {
    if (handle.parentId === null) return false
    if (handle.frame.isDetached()) return true
    return handle.cdp !== this.cdp && CLOSED_RE.test(errorMessage(error))
  }

  /**
   * Content state of every frame, combined: counts summed, the newest change and journal install
   * of any frame, the ambient elements of all. `cutoff`: churn that predates it does not count as
   * content; `from` with `labels`: also name the ambient elements that changed since then. Both are
   * on this process's clock; the state's times are on the browser's.
   */
  private async readState(cutoff: number | null, from: number | null, timeoutMs: number, labels = from !== null): Promise<ContentState> {
    const arg = JSON.stringify({
      cutoff: cutoff === null ? null : await this.onBrowserClock(cutoff),
      from: from === null ? null : await this.onBrowserClock(from),
      labels,
    })
    const reads = await this.eachFrame(await this.readableFrames(), async (entry) => {
      const state = await this.callReader<WorldState>(entry.world, `state(${arg})`, timeoutMs, `reading the page journal state${this.inFrame(entry)}`)
      this.noteDocument(entry, state.token)
      return state
    })
    const combined: ContentState = { now: 0, installedAt: 0, lastContentAt: null, hot: null, ambient: [], content: 0, cosmetic: 0 }
    let newest = -Infinity
    for (const { handle, value } of reads) {
      const where = this.inFrame(handle)
      combined.now = Math.max(combined.now, value.now)
      combined.installedAt = Math.max(combined.installedAt, value.installedAt)
      if (value.lastContentAt !== null) combined.lastContentAt = Math.max(combined.lastContentAt ?? value.lastContentAt, value.lastContentAt)
      combined.content += value.content
      combined.cosmetic += value.cosmetic
      combined.ambient.push(...value.ambient.map((label) => `${label}${where}`))
      // The place named as still changing is in the frame that changed last.
      const changedAt = Math.max(value.lastContentAt ?? 0, value.installedAt)
      if (changedAt > newest) {
        newest = changedAt
        combined.hot = value.hot === null ? null : `${value.hot}${where}`
      }
    }
    return combined
  }

  /** Read every frame's journal from `sinceAt` (this process's clock) on, into `documents`. */
  private async readJournal(sinceAt: number, timeoutMs: number): Promise<void> {
    const entries = await this.readableFrames()
    // A frame that is gone, or cannot be read now, shows none of its documents.
    for (const frameId of [...this.currentDocuments.keys()]) {
      if (!entries.some((entry) => entry.frameId === frameId)) this.currentDocuments.delete(frameId)
    }
    // The earliest browser time `sinceAt` can be, so no entry after it is left behind; unmeasured, everything.
    const from = this.clock.known() ? this.clock.earliestBrowser(sinceAt) : 0
    await this.eachFrame(entries, async (entry) => {
      const read = await this.callReader<WorldRead>(entry.world, `read(${Number(from)})`, timeoutMs, `reading the page journal${this.inFrame(entry)}`)
      const doc = this.noteDocument(entry, read.token)
      for (const rec of read.live) {
        const known = doc.live.get(rec.id)
        if (known) {
          known.text = rec.text
          known.updatedAt = rec.updatedAt
          known.transient = rec.transient
        } else {
          doc.live.set(rec.id, { ...rec, seq: ++this.seq })
        }
      }
      for (const [id, at, content, cosmetic] of read.batches) doc.batches.set(id, { at, content, cosmetic })
      doc.droppedAt = { live: read.liveDroppedAt, mutations: read.droppedAt }
    })
  }

  /**
   * Call a method of a frame's in-page reader, installing the journal first if this world copy has
   * none. Every call is a timed round trip that measures the browser's clock.
   */
  private async callReader<T>(world: IsolatedWorld, call: string, timeoutMs: number, what: string): Promise<T> {
    const expression = `globalThis.${READER} ? { now: Date.now(), ok: true, value: globalThis.${READER}.${call} } : { now: Date.now(), ok: false }`
    for (let attempt = 0; attempt < 2; attempt++) {
      const sentAt = Date.now()
      const result = await world.evaluate<{ now: number; ok: boolean; value?: T }>(expression, { timeoutMs, what })
      this.clock.roundTrip(sentAt, result.now, Date.now())
      if (result.ok) return result.value as T
      // The world was created before start() registered the setup (setups only run in new copies).
      await world.evaluate(WATCH_SOURCE, { timeoutMs, what: 'installing the page journal' })
    }
    throw new Error(`The page journal could not be installed in the isolated world (${what}).`)
  }

  /**
   * `local` (this process's clock) on the browser's clock, for a comparison with the journal's
   * stamps. Before any round trip measured the offset, one bounded round trip does.
   */
  private async onBrowserClock(local: number): Promise<number> {
    if (!this.clock.measured()) {
      const sentAt = Date.now()
      const browser = await this.frames.main.world.evaluate<number>('Date.now()', { timeoutMs: PROBE_TIMEOUT_MS, what: 'reading the browser’s clock' })
      this.clock.roundTrip(sentAt, browser, Date.now())
    }
    return this.clock.toBrowser(local)
  }

  /**
   * Hand each frame's journal the shadow roots it cannot find by itself. Open roots attached
   * without a DOM mutation (a custom element upgraded later) are found by an in-page sweep.
   * Closed roots are invisible to script: DOMSnapshot (one per session, holding the documents of
   * all its frames) marks the nodes inside them, which leads to their light-DOM host, and
   * `DOM.describeNode` on that host lists its roots (nested ones too) with the backend ids the
   * frame's isolated world can resolve.
   */
  private async discoverShadowRoots(entries: FrameHandle[]): Promise<void> {
    const snapshots = new Map<ICDPSession, Promise<Protocol.DOMSnapshot.CaptureSnapshotResponse>>()
    const snapshotOf = (cdp: ICDPSession): Promise<Protocol.DOMSnapshot.CaptureSnapshotResponse> => {
      let snapshot = snapshots.get(cdp)
      if (!snapshot) {
        snapshot = withDeadline(cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }), PROBE_TIMEOUT_MS, 'listing shadow trees (DOMSnapshot.captureSnapshot)')
        snapshots.set(cdp, snapshot)
      }
      return snapshot
    }
    await this.eachFrame(entries, async (entry) => {
      const where = this.inFrame(entry)
      const token = await this.callReader<string>(entry.world, 'sweep()', PROBE_TIMEOUT_MS, `looking for new open shadow roots${where}`)
      const doc = this.noteDocument(entry, token)
      const snapshot = await snapshotOf(entry.cdp)
      const document = snapshot.documents.find((d) => snapshot.strings[d.frameId] === entry.frameId)
      const { parentIndex, backendNodeId, shadowRootType } = document?.nodes ?? {}
      if (!parentIndex || !backendNodeId || !shadowRootType) return
      const typeOf = new Map<number, string>()
      shadowRootType.index.forEach((index, k) => typeOf.set(index, snapshot.strings[shadowRootType.value[k]!]!))
      // Snapshot nodes come parents first: the top host of a shadow node is its parent's, or its parent.
      const topHost = new Map<number, number>()
      const closedHosts = new Set<number>()
      for (const [index, type] of [...typeOf].sort((a, b) => a[0] - b[0])) {
        const parent = parentIndex[index]!
        const host = typeOf.has(parent) ? topHost.get(parent) : parent
        if (host === undefined) continue
        topHost.set(index, host)
        if (type === 'closed') closedHosts.add(host)
      }
      const fresh: number[] = []
      const collect = (node: Protocol.DOM.Node): void => {
        for (const root of node.shadowRoots ?? []) {
          if ((root.shadowRootType === 'open' || root.shadowRootType === 'closed') && !doc.adoptedRoots.has(root.backendNodeId)) fresh.push(root.backendNodeId)
          collect(root)
        }
        // Frames' documents (contentDocument) have journals of their own; only this document's tree.
        for (const child of node.children ?? []) collect(child)
      }
      const hosts = await Promise.all(
        [...closedHosts].map((index) =>
          withDeadline(
            entry.cdp.send('DOM.describeNode', { backendNodeId: backendNodeId[index]!, depth: -1, pierce: true }),
            PROBE_TIMEOUT_MS,
            `listing the shadow roots of a closed shadow host${where}`,
          ),
        ),
      )
      for (const { node } of hosts) collect(node)
      if (fresh.length === 0) return
      const adopted = await entry.world.callFunctionOnNodes<number>(fresh, ADOPT_ROOTS_FN, {
        timeoutMs: PROBE_TIMEOUT_MS,
        what: `observing shadow roots${where}`,
      })
      if (adopted >= 0) for (const id of fresh) doc.adoptedRoots.add(id)
    })
  }

  /**
   * The journal of the document `entry` shows now (its in-page journal is `token`). Every frame's
   * current document is kept, and the last DOCUMENT_CAP documents frames have left.
   */
  private noteDocument(entry: FrameHandle, token: string): DocumentJournal {
    const key = `${entry.frameId} ${token}`
    let doc = this.documents.get(key)
    if (!doc) {
      doc = {
        frameId: entry.frameId,
        frameUrl: entry.parentId === null ? null : entry.frame.url(),
        live: new Map(),
        batches: new Map(),
        adoptedRoots: new Set(),
        droppedAt: { live: null, mutations: null },
      }
      this.documents.set(key, doc)
    }
    this.currentDocuments.set(entry.frameId, doc)
    const current = new Set(this.currentDocuments.values())
    const left = [...this.documents].filter(([, journal]) => !current.has(journal))
    for (const [oldKey] of left.slice(0, Math.max(0, left.length - DOCUMENT_CAP))) this.documents.delete(oldKey)
    return doc
  }

  /** Create the frames' worlds (running the journal setup) now, so mutations are seen from the start. A frozen or closed page is not probed. */
  private async installJournals(entries: FrameHandle[]): Promise<void> {
    if (!this.started || this.dialogs.current() || this.isClosed?.()) return
    await this.discoverShadowRoots(entries)
  }

  /** A navigation started: read the old documents' journals while they still exist (best effort). */
  private readBeforeLeaving(): void {
    if (this.dialogs.current() || this.currentDocuments.size === 0) return
    void this.readJournal(0, PROBE_TIMEOUT_MS).catch((error) => this.reportBackgroundError('reading the journal before navigation', error))
  }

  private reportBackgroundError(what: string, error: unknown): void {
    if (!this.started || this.isClosed?.() || this.dialogs.current()) return
    const message = errorMessage(error)
    if (DEAD_CONTEXT_RE.test(message) || CLOSED_RE.test(message)) return
    this.logger.error(`[page-watch] ${what} failed:`, message)
  }

  // ---------------------------------------------------------------------------
  // frames and their sessions
  // ---------------------------------------------------------------------------

  /** Run `work` after the work already queued for `frameId`: a frame's attach, navigations and removal are followed in order. */
  private queueFrame(frameId: string, work: () => Promise<void>): void {
    const queued = (this.frameWork.get(frameId) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => this.reportBackgroundError('following an iframe', error))
    this.frameWork.set(frameId, queued)
    void queued.then(() => {
      if (this.frameWork.get(frameId) === queued) this.frameWork.delete(frameId)
    })
  }

  /**
   * An iframe appeared, navigated, went away, or was found at start (`listed`): follow the
   * session that owns it now, and install the journal in its new document right away.
   */
  private async followFrame(frameId: string, kind: FrameChange['kind'] | 'listed'): Promise<void> {
    if (!this.started) return
    if (kind === 'detached') {
      this.currentDocuments.delete(frameId)
      const tracked = this.oopifSessions.get(frameId)
      if (tracked) this.retireSession(tracked, 'the iframe that sent it was removed from the page')
      return
    }
    let handle: FrameHandle
    try {
      handle = await this.frames.handle(frameId)
    } catch (error) {
      // Removed meanwhile: its `detached` change is next in this frame's queue.
      if (error instanceof FrameGoneError || !this.frames.page.frames().some((frame) => frame.frameId() === frameId)) return
      // Its session cannot be borrowed, so it is not followed: what the tap holds for it is let go.
      // (A failure of the journal install below is not one: a frame that has just moved to another
      // process fails it, and the follow of its navigation takes the new session.)
      this.tap?.discard(frameId)
      // No debugger may enter it (another extension's page): not following it is the answer, not a failure.
      if (error instanceof SealedFrameError) return
      throw error
    }
    if (!this.started) return
    this.followOutOfProcess(handle)
    if (kind !== 'listed') await this.installJournals([handle])
  }

  /**
   * Journal the network and console of the iframe's own session while it is out of process, from
   * the session's first event: the tap has held them since Playwright created the session.
   */
  private followOutOfProcess(handle: FrameHandle): void {
    const tracked = this.oopifSessions.get(handle.frameId)
    if (!handle.outOfProcess) {
      if (tracked) this.retireSession(tracked, 'the iframe that sent it moved into its parent’s renderer process')
      return
    }
    const tapped = this.tap?.session(handle.frameId) ?? null
    if (tapped === null) {
      throw new Error(`Playwright's server holds no session of its own for the out-of-process iframe ${handle.frame.url() || handle.frameId}.`)
    }
    if (tracked) {
      // An iframe that stays out of process keeps its target, and Playwright its session, across
      // navigations (measured): only the adapter that commands go through can be new.
      if (tracked.tapped === tapped) {
        tracked.cdp = handle.cdp
        return
      }
      this.retireSession(tracked, 'the iframe that sent it moved to another renderer process')
    }
    this.oopifSessions.set(handle.frameId, this.watchSession(handle.cdp, handle.frame, tapped, null))
    tapped.start()
  }

  /**
   * Journal a dedicated worker's requests (nested workers too), from its session's first event; the
   * tap hands it over as Playwright creates the session. The requests it still had open when it ended
   * end as `lost`.
   */
  private followWorker(worker: TappedWorker): void {
    const session = this.watchSession(worker.cdp, null, worker.session, worker.url)
    worker.session.onClose(() => this.retireSession(session, `the worker ${worker.url} that sent it ended`))
    worker.session.start()
  }

  /**
   * Stop following a session that no longer carries the frame (or whose worker ended). Chrome
   * reports nothing more about the requests it last reported there: they end as `lost`, with why.
   */
  private retireSession(session: SessionWatch, reason: string): void {
    for (const off of session.off.splice(0)) off()
    this.sessions.delete(session)
    for (const [frameId, tracked] of this.oopifSessions) {
      if (tracked === session) this.oopifSessions.delete(frameId)
    }
    const now = Date.now()
    for (const entry of this.requestsById.values()) {
      if (entry.session !== session) continue
      if (entry.endedAt !== undefined) continue
      entry.endedAt = now
      entry.lost = reason
    }
  }

  // ---------------------------------------------------------------------------
  // CDP events
  // ---------------------------------------------------------------------------

  /**
   * Journal the requests, WebSocket frames, console and exceptions a session reports. A worker's
   * session runs only the worker's own code (it has no other world), so its console is the page's own
   * code and is named by the worker, without asking its session anything.
   */
  private watchSession(cdp: ICDPSession, rootFrame: Frame | null, tapped: TappedSession | null, worker: string | null): SessionWatch {
    const session: SessionWatch = { cdp, tapped, rootFrame, worker, socketUrls: new Map(), contexts: new Map(), off: [] }
    this.sessions.add(session)
    this.listen(session, 'Network.requestWillBeSent', (e, at) => this.onRequestWillBeSent(session, e, at))
    this.listen(session, 'Network.responseReceived', (e, at) => this.onResponseReceived(session, e, at))
    this.listen(session, 'Network.dataReceived', (e, at) => {
      const entry = this.reportedBy(session, e.requestId)
      if (entry && entry.endedAt === undefined) entry.lastDataAt = at
    })
    this.listen(session, 'Network.loadingFinished', (e, at) => this.onRequestEnded(session, e.requestId, at))
    this.listen(session, 'Network.loadingFailed', (e, at) => this.onRequestEnded(session, e.requestId, at, failureOf(e), e.type))
    this.listen(session, 'Network.requestServedFromCache', (e) => {
      const entry = this.reportedBy(session, e.requestId)
      if (entry) entry.fromCache = true
    })
    this.listen(session, 'Network.webSocketCreated', (e) => session.socketUrls.set(e.requestId, e.url))
    this.listen(session, 'Network.webSocketClosed', (e) => session.socketUrls.delete(e.requestId))
    this.listen(session, 'Network.webSocketFrameSent', (e, at) => this.onSocketFrame(session, e, 'sent', at))
    this.listen(session, 'Network.webSocketFrameReceived', (e, at) => this.onSocketFrame(session, e, 'received', at))
    this.listen(session, 'Runtime.consoleAPICalled', (e, at) => this.onConsole(session, e, at))
    this.listen(session, 'Runtime.exceptionThrown', (e, at) => this.onException(session, e, at))
    if (worker !== null) return session
    this.listen(session, 'Runtime.executionContextCreated', (e) => this.onContextCreated(session, e))
    this.listen(session, 'Runtime.executionContextDestroyed', (e) => session.contexts.delete(e.executionContextId))
    this.listen(session, 'Runtime.executionContextsCleared', () => session.contexts.clear())
    this.listen(session, 'Page.downloadWillBegin', (e, at) => this.onDownload(e, at))
    return session
  }

  /** Journal `event` of a followed session, with when it reached this process: an iframe's from its tap, the page's from its session. */
  private listen<K extends TappedEvent>(session: SessionWatch, event: K, handler: TapListener<K>): void {
    const guarded: TapListener<K> = (params, arrivedAt) => {
      try {
        handler(params, arrivedAt)
      } catch (error) {
        this.logger.error(`[page-watch] handling ${event} failed:`, errorMessage(error))
      }
    }
    const { tapped, cdp } = session
    if (tapped) {
      tapped.on(event, guarded)
      session.off.push(() => tapped.off(event, guarded))
      return
    }
    const arrive = (params: ProtocolMapping.Events[K][0]): void => guarded(params, Date.now())
    cdp.on(event, arrive)
    session.off.push(() => cdp.off(event, arrive))
  }

  /** The page session's navigation and loading events. */
  private listenPage<K extends keyof ProtocolMapping.Events>(event: K, handler: (params: ProtocolMapping.Events[K][0]) => void): void {
    const guarded = (params: ProtocolMapping.Events[K][0]): void => {
      try {
        handler(params)
      } catch (error) {
        this.logger.error(`[page-watch] handling ${event} failed:`, errorMessage(error))
      }
    }
    this.cdp.on(event, guarded)
    this.unlisten.push(() => this.cdp.off(event, guarded))
  }

  private onRequestWillBeSent(session: SessionWatch, e: Protocol.Network.RequestWillBeSentEvent, arrivedAt: number): void {
    // When the renderer issued it, on the browser's clock: an event that reaches this process late
    // must not turn a request from before the action into one of its. Its arrival bounds the clock.
    const issuedAt = e.wallTime * 1000
    this.clock.arrived(issuedAt, arrivedAt)
    const url = e.request.url + (e.request.urlFragment ?? '')
    const known = this.requestsById.get(e.requestId)
    // The same hop announced again by another of the page's sessions: one request, one record.
    if (known && known.endedAt === undefined && known.issuedAt === issuedAt && known.url === url) {
      known.session = session
      return
    }
    // A new hop of the request: one Chrome reports with its redirect response, or — measured on a
    // fetch whose redirect the page's Content Security Policy then blocked — one it moves the still
    // open request on to without reporting the redirect response.
    const previous = e.redirectResponse || (known && known.endedAt === undefined) ? known : undefined
    const entry: RequestEntry = {
      id: `r${++this.requestCounter}`,
      requestId: e.requestId,
      session,
      seq: ++this.seq,
      method: e.request.method,
      url,
      ...(e.frameId !== undefined ? { frameId: e.frameId } : {}),
      // Sent by a worker: named by its script's address; by an iframe's document: by that document's, as console records are.
      ...(session.worker !== null
        ? { worker: session.worker }
        : e.frameId !== undefined && e.frameId !== this.frames.mainFrameId()
          ? { frame: e.documentURL }
          : {}),
      ...(e.type !== undefined ? { resourceType: e.type } : {}),
      issuedAt,
      chainIssuedAt: previous?.chainIssuedAt ?? issuedAt,
      ...(e.request.isAdRelated ? { isAdRelated: true } : {}),
    }
    if (previous) {
      // A redirect keeps Chrome's requestId; each hop is its own record, so a POST answered
      // with 303 stays a POST and the GET that follows is a new request.
      if (e.redirectResponse) {
        previous.status = e.redirectResponse.status
        previous.mimeType = e.redirectResponse.mimeType
        previous.headersAt ??= arrivedAt
      }
      previous.endedAt ??= arrivedAt
      previous.redirectedTo = entry.id
      entry.redirectedFrom = previous.id
    }
    this.requestLog.push(entry)
    this.requestsById.set(e.requestId, entry)
    while (this.requestLog.length > REQUEST_CAP) {
      const dropped = this.requestLog.shift()!
      this.droppedSeq.network = dropped.seq
      if (this.requestsById.get(dropped.requestId) === dropped) this.requestsById.delete(dropped.requestId)
    }
  }

  /** The journaled request `requestId`, now reported by `session` — the one that holds what Chrome reports of it from here on, its body included. */
  private reportedBy(session: SessionWatch, requestId: string): RequestEntry | undefined {
    const entry = this.requestsById.get(requestId)
    if (entry) entry.session = session
    return entry
  }

  private onResponseReceived(session: SessionWatch, e: Protocol.Network.ResponseReceivedEvent, arrivedAt: number): void {
    const entry = this.reportedBy(session, e.requestId)
    if (!entry) return
    entry.status = e.response.status
    entry.mimeType = e.response.mimeType
    entry.resourceType = e.type
    entry.headersAt = arrivedAt
    if (e.response.fromDiskCache || e.response.fromPrefetchCache) entry.fromCache = true
  }

  private onRequestEnded(session: SessionWatch, requestId: string, arrivedAt: number, failed?: string, type?: Protocol.Network.ResourceType): void {
    const entry = this.reportedBy(session, requestId)
    if (!entry || entry.endedAt !== undefined) return
    entry.endedAt = arrivedAt
    if (failed !== undefined) entry.failed = failed
    if (type !== undefined) entry.resourceType = type
  }

  /**
   * A frame's navigation became a download. Chrome cancels the navigation request for it
   * (`loadingFailed` net::ERR_ABORTED, canceled) and then announces the download for the frame with
   * the request's final URL (measured, in that order, locally and on GitHub). That request ended by
   * becoming the download: it did not fail.
   */
  private onDownload(e: Protocol.Page.DownloadWillBeginEvent, arrivedAt: number): void {
    const entry = this.requestLog.findLast(
      (candidate) =>
        candidate.frameId === e.frameId &&
        candidate.url === e.url &&
        candidate.resourceType === 'Document' &&
        candidate.download === undefined &&
        candidate.redirectedTo === undefined &&
        (candidate.endedAt === undefined || candidate.failed === 'canceled'),
    )
    if (!entry) return
    entry.download = e.suggestedFilename
    delete entry.failed
    entry.endedAt ??= arrivedAt
  }

  private onSocketFrame(session: SessionWatch, e: Protocol.Network.WebSocketFrameSentEvent, direction: WebSocketFrameRecord['direction'], arrivedAt: number): void {
    const url = session.socketUrls.get(e.requestId)
    this.socketLog.push({
      seq: ++this.seq,
      requestId: e.requestId,
      ...(url !== undefined ? { url } : {}),
      direction,
      at: arrivedAt,
      opcode: e.response.opcode,
      bytes: payloadBytes(e.response),
    })
    if (this.socketLog.length > WEBSOCKET_CAP) this.droppedSeq.webSockets = this.socketLog.shift()!.seq
  }

  private onFrameNavigated(e: Protocol.Page.FrameNavigatedEvent): void {
    if (e.frame.parentId || e.frame.id !== this.frames.mainFrameId()) return
    const url = e.frame.url + (e.frame.urlFragment ?? '')
    const navigationType = this.startedNavigations.get(e.frame.loaderId)
    this.startedNavigations.clear()
    this.mainDocumentId = e.frame.loaderId
    this.currentUrl = url
    this.pushNavigation(e.type === 'BackForwardCacheRestore' ? 'restored' : 'cross-document', url, navigationType)
    this.wake()
  }

  private pushNavigation(kind: NavigationRecord['kind'], url: string, navigationType: string | undefined): void {
    this.navigationLog.push({ seq: ++this.seq, at: Date.now(), kind, url, ...(navigationType !== undefined ? { navigationType } : {}) })
    if (this.navigationLog.length > NAVIGATION_CAP) this.droppedSeq.navigations = this.navigationLog.shift()!.seq
  }

  /**
   * A context announced as it was created: a frame's default context is the page's own code;
   * every other one (isolated worlds, extensions' content scripts) is not. The main frame's new
   * main world also means a new main document, whose journal is installed right away.
   */
  private onContextCreated(session: SessionWatch, e: Protocol.Runtime.ExecutionContextCreatedEvent): void {
    // The protocol types auxData as `any`; Chromium fills { isDefault, type, frameId } for frame contexts.
    const aux: { isDefault?: boolean; frameId?: string } | undefined = e.context.auxData
    const frameId = aux?.frameId
    if (aux?.isDefault !== true || frameId === undefined) {
      session.contexts.set(e.context.id, Promise.resolve(null))
      return
    }
    if (session.rootFrame === null && frameId === this.frames.mainFrameId()) {
      session.contexts.set(e.context.id, Promise.resolve({}))
      void this.installJournals([this.frames.main]).catch((error) => this.reportBackgroundError('installing the page journal', error))
      return
    }
    // A frame Playwright does not know yet is identified from the context itself when it logs.
    const frame = this.frames.page.frames().find((candidate) => candidate.frameId() === frameId)
    if (frame) session.contexts.set(e.context.id, Promise.resolve({ frame: frame.url() }))
  }

  private onConsole(session: SessionWatch, e: Protocol.Runtime.ConsoleAPICalledEvent, arrivedAt: number): void {
    const level = e.type === 'error' || e.type === 'assert' ? 'error' : e.type === 'warning' ? 'warning' : null
    if (!level) return
    const body = e.args.map(formatRemoteObject).join(' ')
    const text = e.type === 'assert' ? `Assertion failed${body ? `: ${body}` : ''}` : body
    const top = e.stackTrace?.callFrames[0]
    this.pushConsole(
      session,
      { seq: ++this.seq, at: arrivedAt, level, text: clipText(text, CONSOLE_TEXT_CAP), location: top ? formatLocation(top.url, top.lineNumber, top.columnNumber) : undefined },
      e.executionContextId,
    )
  }

  private onException(session: SessionWatch, e: Protocol.Runtime.ExceptionThrownEvent, arrivedAt: number): void {
    const d = e.exceptionDetails
    const description = d.exception?.description?.split('\n', 1)[0]
    const text = description ? `${d.text && d.text !== description ? `${d.text} ` : ''}${description}` : d.text
    const top = d.stackTrace?.callFrames[0]
    const location = d.url ? formatLocation(d.url, d.lineNumber, d.columnNumber) : top ? formatLocation(top.url, top.lineNumber, top.columnNumber) : undefined
    this.pushConsole(session, { seq: ++this.seq, at: arrivedAt, level: 'exception', text: clipText(text, CONSOLE_TEXT_CAP), location }, d.executionContextId)
  }

  /**
   * Journal a console record of the page's own code, in any frame or worker. Isolated worlds
   * (playwriter's probes, Playwright's utility world) and extensions' content scripts are not
   * the app: a document's record is kept only when its context is a frame's main world. A worker's
   * is its own code.
   */
  private pushConsole(session: SessionWatch, record: ConsoleRecord, contextId: number | undefined): void {
    if (record.location === undefined) delete record.location
    const owner =
      session.worker !== null
        ? Promise.resolve({ worker: session.worker })
        : contextId !== undefined
          ? this.ownerOf(session, contextId)
          : Promise.resolve(session.rootFrame === null ? {} : { frame: session.rootFrame.url() })
    this.consoleLog.push({ record, owner })
    if (this.consoleLog.length > CONSOLE_CAP) this.droppedSeq.console = this.consoleLog.shift()!.record.seq
  }

  private async ownConsole(afterSeq: number): Promise<ConsoleRecord[]> {
    const entries = this.consoleLog.filter((entry) => entry.record.seq > afterSeq)
    const owners = await withDeadline(
      Promise.all(entries.map((entry) => entry.owner)),
      PROBE_TIMEOUT_MS,
      'telling the page’s console messages from isolated worlds’',
    )
    const out: ConsoleRecord[] = []
    entries.forEach((entry, index) => {
      const owner = owners[index]
      if (owner) out.push({ ...entry.record, ...(owner.frame !== undefined ? { frame: owner.frame } : {}), ...(owner.worker !== undefined ? { worker: owner.worker } : {}) })
    })
    return out
  }

  private ownerOf(session: SessionWatch, contextId: number): Promise<ContextOwner> {
    let known = session.contexts.get(contextId)
    if (!known) {
      known = this.identifyContext(session, contextId)
      known.catch(() => {})
      session.contexts.set(contextId, known)
    }
    return known
  }

  /**
   * Whose code runs in a context that was not announced while its session was followed (it
   * existed before start(), or before an out-of-process iframe's session was borrowed). The
   * context's `document` — an unforgeable property, so reading it runs no page code — is
   * resolved again without a context, which Chrome does in the main world of its frame; Chrome
   * refuses to compare objects of two different contexts, so the comparison succeeds exactly
   * when the context is that main world. Its frame is the main frame when its document is the
   * one the page session's default context shows.
   */
  private async identifyContext(session: SessionWatch, contextId: number): Promise<ContextOwner> {
    const { cdp } = session
    const objectGroup = `playwriter-watch-context-${contextId}`
    const what = `identifying execution context ${contextId}`
    const send = <M extends 'Runtime.evaluate' | 'Runtime.callFunctionOn' | 'DOM.describeNode' | 'DOM.resolveNode'>(
      method: M,
      params: ProtocolMapping.Commands[M]['paramsType'][0],
    ): Promise<ProtocolMapping.Commands[M]['returnType']> => withDeadline(cdp.send(method, params), PROBE_TIMEOUT_MS, what)
    try {
      const theirs = await send('Runtime.evaluate', { expression: 'document', contextId, objectGroup })
      const theirsId = theirs.result.objectId
      // No document: not a frame's world.
      if (theirs.exceptionDetails || theirs.result.subtype !== 'node' || !theirsId) return null
      const { node } = await send('DOM.describeNode', { objectId: theirsId })
      const resolved = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup })
      if (!resolved.object.objectId) throw new Error(`${what}: DOM.resolveNode returned no object for its document.`)
      const same = await send('Runtime.callFunctionOn', {
        functionDeclaration: 'function (other) { return this === other }',
        objectId: resolved.object.objectId,
        arguments: [{ objectId: theirsId }],
        returnByValue: true,
      })
      if (same.result.value !== true) return null
      if (session.rootFrame === null) {
        const top = await send('Runtime.evaluate', { expression: 'document', objectGroup })
        if (!top.result.objectId) throw new Error(`${what}: the page's default context returned no document.`)
        const { node: topNode } = await send('DOM.describeNode', { objectId: top.result.objectId })
        if (topNode.backendNodeId === node.backendNodeId) return {}
      }
      if (node.documentURL === undefined) throw new Error(`${what}: Chrome described its document without a URL.`)
      return { frame: node.documentURL }
    } catch (error) {
      // A context that is gone (with its session, for an iframe that left), or one Chrome refuses
      // to mix with its frame's main world, is not the page's own.
      const message = errorMessage(error)
      if (OTHER_WORLD_RE.test(message) || DEAD_CONTEXT_RE.test(message) || CLOSED_RE.test(message)) return null
      throw error
    } finally {
      await withDeadline(cdp.send('Runtime.releaseObjectGroup', { objectGroup }), PROBE_TIMEOUT_MS, 'releasing context probes').catch(() => {})
    }
  }

  private onDialogChange(state: JsDialogState | null): void {
    const open = this.dialogLog.at(-1)?.closedSeq === undefined ? this.dialogLog.at(-1) : undefined
    const same = open && state && open.state.openedAt === state.openedAt && open.state.message === state.message && open.state.type === state.type
    if (state && state.closedAt === undefined) {
      if (same) {
        open.state = state
      } else {
        if (open) open.closedSeq = ++this.seq
        this.dialogLog.push({ state, openedSeq: ++this.seq })
        if (this.dialogLog.length > DIALOG_CAP) this.dialogLog.shift()
      }
    } else if (open) {
      open.closedSeq = ++this.seq
    }
    for (const notify of [...this.dialogWaiters]) notify()
    this.wake()
  }

  /** A dialog the policy answers closes by itself within a round trip; one the agent answers makes the page unreadable. */
  private async waitOutAutoDialog(what: string): Promise<void> {
    const deadline = Date.now() + PROBE_TIMEOUT_MS
    for (let dialog = this.dialogs.current(); dialog; dialog = this.dialogs.current()) {
      if (dialog.handling === 'agent') {
        throw new ModelFacingError(
          `Cannot finish ${what}: a native ${dialog.type} dialog is open ("${clipText(dialog.message, 120)}"). ` +
            'The page is frozen until it is answered: act.dialog.accept() or act.dialog.dismiss().',
        )
      }
      if (Date.now() >= deadline) {
        throw new PageUnresponsiveError(`waiting for the ${dialog.type} dialog "${clipText(dialog.message, 80)}" to be answered automatically`, PROBE_TIMEOUT_MS)
      }
      await this.untilDialogChange(deadline)
    }
  }

  // ---------------------------------------------------------------------------
  // waiting primitives
  // ---------------------------------------------------------------------------

  /** Race a probe against a dialog opening: a probe of a page frozen by a dialog would only hit its deadline. */
  private async unlessDialog<T>(work: Promise<T>): Promise<Raced<T>> {
    work.catch(() => {})
    if (this.dialogs.current()) return { dialog: true }
    const opened = Promise.withResolvers<{ dialog: true }>()
    const onChange = (): void => {
      if (this.dialogs.current()) opened.resolve({ dialog: true })
    }
    this.dialogWaiters.add(onChange)
    try {
      return await Promise.race([work.then((value) => ({ value })), opened.promise])
    } finally {
      this.dialogWaiters.delete(onChange)
    }
  }

  /** Until the dialog state changes (or `deadline`). */
  private async untilDialogChange(deadline: number): Promise<void> {
    const changed = Promise.withResolvers<void>()
    const onChange = (): void => changed.resolve()
    this.dialogWaiters.add(onChange)
    const timer = setTimeout(changed.resolve, Math.max(0, deadline - Date.now()))
    try {
      await changed.promise
    } finally {
      clearTimeout(timer)
      this.dialogWaiters.delete(onChange)
    }
  }

  private async pause(ms: number): Promise<void> {
    const woken = Promise.withResolvers<void>()
    this.wakers.add(woken.resolve)
    const timer = setTimeout(woken.resolve, ms)
    try {
      await woken.promise
    } finally {
      clearTimeout(timer)
      this.wakers.delete(woken.resolve)
    }
  }

  private wake(): void {
    for (const notify of [...this.wakers]) notify()
  }
}

/** How long the content has been still, counting a journal's install as a change (it cannot vouch for earlier). */
function msSinceContent(state: ContentState): number {
  return state.now - Math.max(state.lastContentAt ?? 0, state.installedAt)
}
