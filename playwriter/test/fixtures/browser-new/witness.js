/*
 * Browser Lab witness.
 * Records what an automation tool does to this page and reports it to the lab
 * server with navigator.sendBeacon('/witness', json) every second and on pagehide.
 * Graders read the reports with GET /witness?tag=<tag>; the tool never has to.
 *
 * The page declares its own DOM changes by running them inside lab.m(fn)
 * (or through lab.on / lab.later / lab.every / lab.frame, which wrap lab.m).
 * Everything else that mutates the DOM after DOMContentLoaded is "foreign",
 * except mutations inside user-editable regions ([data-lab-editable] or
 * lab.editable(el)) and attribute names declared with lab.nativeAttr(el, names).
 */
(() => {
  'use strict';
  if (window.lab) return;

  const W = window;
  const D = document;
  const T0 = performance.now();
  const now = () => Math.round(performance.now() - T0);
  const startedAtEpochMs = Date.now();

  // ---- saved originals (the witness never goes through APIs a tool might patch) ----
  const C = W.console;
  const orig = {
    'console.debug': C.debug,
    'console.log': C.log,
    'console.info': C.info,
    'console.warn': C.warn,
    'console.error': C.error,
    fetch: W.fetch,
    'XMLHttpRequest.prototype.open': XMLHttpRequest.prototype.open,
    'XMLHttpRequest.prototype.send': XMLHttpRequest.prototype.send,
    'history.pushState': W.history.pushState,
    'history.replaceState': W.history.replaceState,
    'EventTarget.prototype.addEventListener': EventTarget.prototype.addEventListener,
    'Element.prototype.attachShadow': Element.prototype.attachShadow,
    'Navigator.prototype.sendBeacon': Navigator.prototype.sendBeacon,
    'window.alert': W.alert,
    'window.confirm': W.confirm,
    'window.prompt': W.prompt,
    'window.open': W.open,
  };
  const current = {
    'console.debug': () => W.console.debug,
    'console.log': () => W.console.log,
    'console.info': () => W.console.info,
    'console.warn': () => W.console.warn,
    'console.error': () => W.console.error,
    fetch: () => W.fetch,
    'XMLHttpRequest.prototype.open': () => XMLHttpRequest.prototype.open,
    'XMLHttpRequest.prototype.send': () => XMLHttpRequest.prototype.send,
    'history.pushState': () => W.history.pushState,
    'history.replaceState': () => W.history.replaceState,
    'EventTarget.prototype.addEventListener': () => EventTarget.prototype.addEventListener,
    'Element.prototype.attachShadow': () => Element.prototype.attachShadow,
    'Navigator.prototype.sendBeacon': () => Navigator.prototype.sendBeacon,
    'window.alert': () => W.alert,
    'window.confirm': () => W.confirm,
    'window.prompt': () => W.prompt,
    'window.open': () => W.open,
  };
  const debug = orig['console.debug'];
  const sendBeacon = orig['Navigator.prototype.sendBeacon'];
  const listen = orig['EventTarget.prototype.addEventListener'];
  const setIntervalOrig = W.setInterval.bind(W);
  const setTimeoutOrig = W.setTimeout.bind(W);
  const rafOrig = W.requestAnimationFrame.bind(W);

  // ---- identity ----
  const baselineGlobals = new Set(Object.getOwnPropertyNames(W));
  const declaredGlobals = new Set(['lab']);
  const AUTOMATION = /^(__pw|__playwright|playwright|puppeteer|__puppeteer|cdc_|\$cdc|__omp|omp|__webdriver|webdriver|__selenium|_selenium|__nightmare|callPhantom|_phantom|domAutomation)/i;
  const tag = new URLSearchParams(location.search).get('tag') || 'untagged';
  const instance = startedAtEpochMs.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  let frameKind = 'top';
  try { frameKind = W.top === W ? 'top' : 'child'; } catch { frameKind = 'child'; }

  const clip = (s, n = 80) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

  // ---- node descriptions ----
  function desc(n) {
    if (!n) return 'null';
    switch (n.nodeType) {
      case 1: {
        let s = n.localName;
        if (n.id) s += '#' + n.id;
        const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
        if (cls.length) s += '.' + cls.join('.');
        const name = n.getAttribute('name');
        if (name) s += '[name=' + name + ']';
        return clip(s, 80);
      }
      case 3: return '#text"' + clip(n.data.trim(), 30) + '"';
      case 8: return '#comment';
      case 9: return '#document';
      case 11: return n.host ? desc(n.host) + '::shadow-root' : '#fragment';
      default: return '#node' + n.nodeType;
    }
  }
  function label(n) {
    if (!n || n.nodeType !== 1) return '';
    const aria = n.getAttribute('aria-label');
    if (aria) return aria;
    const tagName = n.localName;
    if (tagName === 'input' || tagName === 'select' || tagName === 'textarea') return (n.type || tagName) + (n.name ? ':' + n.name : '');
    if (n.children.length > 6) return '';
    return (n.textContent || '').trim().replace(/\s+/g, ' ');
  }
  function descEl(n) {
    if (n === D) return '#document';
    if (n === W) return 'window';
    const base = desc(n);
    const l = label(n);
    return l ? base + ' "' + clip(l, 30) + '"' : base;
  }

  // ---- mutation classification ----
  const OBSERVE = { childList: true, attributes: true, characterData: true, subtree: true, attributeOldValue: true, characterDataOldValue: true };
  const MAX_FOREIGN = 200;
  const observers = [];
  const shadowRoots = [];
  const ownMutations = { code: 0, parser: 0, editable: 0, native: 0 };
  const foreignMutations = [];
  const foreignByType = { childList: 0, attributes: 0, characterData: 0 };
  let foreignCount = 0;
  let phase = D.readyState === 'loading' ? 'parse' : 'live';
  let depth = 0;
  const editableRoots = new WeakSet();
  const editableNodes = new WeakSet();
  const nativeAttrs = new WeakMap();

  const up = (n) => n.parentNode || (n.nodeType === 11 ? n.host : null);
  const isEditableRoot = (n) => n.nodeType === 1 && (editableRoots.has(n) || n.hasAttribute('data-lab-editable'));
  // strict (attribute records): the target must lie strictly inside an editable root;
  // users cannot change attributes of the editable root itself.
  function inEditable(n, strict) {
    const root = n.nodeType === 1 && isEditableRoot(n);
    if (editableNodes.has(n) && !(strict && root)) return true;
    if (!strict && root) return true;
    for (let x = up(n); x; x = up(x)) if (isEditableRoot(x) || editableNodes.has(x)) return true;
    return false;
  }
  function markTree(n) {
    editableNodes.add(n);
    const walker = D.createTreeWalker(n, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) editableNodes.add(walker.currentNode);
  }
  function scanEditables() {
    for (const el of D.querySelectorAll('[data-lab-editable]')) { editableRoots.add(el); markTree(el); }
  }
  function compact(r) {
    const o = { t: now(), type: r.type, target: desc(r.target), parent: desc(up(r.target)) };
    if (r.type === 'attributes') {
      o.attr = r.attributeName;
      o.old = clip(r.oldValue);
      o.value = clip(r.target.getAttribute ? r.target.getAttribute(r.attributeName) : null);
    } else if (r.type === 'characterData') {
      o.old = clip(r.oldValue);
      o.value = clip(r.target.data);
    } else {
      if (r.addedNodes.length) { o.added = Array.from(r.addedNodes).slice(0, 5).map(desc); if (r.addedNodes.length > 5) o.addedTotal = r.addedNodes.length; }
      if (r.removedNodes.length) { o.removed = Array.from(r.removedNodes).slice(0, 5).map(desc); if (r.removedNodes.length > 5) o.removedTotal = r.removedNodes.length; }
    }
    return o;
  }
  function classify(records, forced) {
    for (const r of records) {
      const editable = inEditable(r.target, r.type === 'attributes');
      if (editable) for (const a of r.addedNodes) markTree(a);
      let kind = forced;
      if (!kind) {
        if (phase === 'parse') kind = 'parser';
        else if (editable) kind = 'editable';
        else if (r.type === 'attributes' && nativeAttrs.get(r.target)?.has(r.attributeName)) kind = 'native';
      }
      if (kind) { ownMutations[kind]++; continue; }
      foreignCount++;
      foreignByType[r.type]++;
      if (foreignMutations.length < MAX_FOREIGN) foreignMutations.push(compact(r));
    }
  }
  function observe(root) {
    const o = new MutationObserver((recs) => classify(recs, null));
    o.observe(root, OBSERVE);
    observers.push(o);
  }
  function drain(forced) {
    for (const o of observers) {
      const recs = o.takeRecords();
      if (recs.length) classify(recs, forced);
    }
  }
  observe(D.documentElement);

  function m(fn) {
    if (depth === 0) drain(null);
    depth++;
    try { return fn(); } finally { if (--depth === 0) drain('code'); }
  }

  listen.call(D, 'DOMContentLoaded', () => {
    drain(null);
    phase = 'live';
    scanEditables();
  }, { capture: true });
  if (phase === 'live') scanEditables();

  // ---- globals, stylesheets, patched APIs ----
  const foreignGlobalsSeen = new Set();
  const automationSeen = new Set();
  const patchedSeen = new Set();
  function scanGlobals() {
    for (const k of Object.getOwnPropertyNames(W)) {
      if (AUTOMATION.test(k)) automationSeen.add(k);
      if (!baselineGlobals.has(k) && !declaredGlobals.has(k) && !/^\d+$/.test(k)) foreignGlobalsSeen.add(k);
    }
    for (const k of Object.getOwnPropertyNames(D)) if (AUTOMATION.test(k)) automationSeen.add('document.' + k);
    for (const k of Object.keys(current)) {
      try { if (current[k]() !== orig[k]) patchedSeen.add(k); } catch { patchedSeen.add(k); }
    }
  }
  const ownSheets = new WeakSet();
  const sheetsSeen = new Set();
  const sheetsAdded = [];
  function noteSheet(sheet, source) {
    if (sheetsSeen.has(sheet) || ownSheets.has(sheet)) return;
    const owner = sheet.ownerNode;
    if (owner && owner.nodeType === 1 && owner.hasAttribute('data-lab-own')) return;
    sheetsSeen.add(sheet);
    let rules = null;
    let sample = null;
    try { rules = sheet.cssRules.length; sample = rules ? clip(sheet.cssRules[0].cssText, 80) : ''; } catch { rules = 'unreadable'; }
    sheetsAdded.push({ t: now(), source, owner: owner ? desc(owner) : null, href: sheet.href || null, rules, sample });
  }
  function scanSheets() {
    for (const s of D.styleSheets) noteSheet(s, 'document');
    for (const s of D.adoptedStyleSheets || []) noteSheet(s, 'document.adoptedStyleSheets');
    for (const root of shadowRoots) {
      for (const s of root.styleSheets) noteSheet(s, desc(root));
      for (const s of root.adoptedStyleSheets || []) noteSheet(s, desc(root) + '.adoptedStyleSheets');
    }
  }

  // ---- console-getter detector (CDP Runtime.enable) ----
  // A detached <div> whose own `nodeName` is an accessor. Chrome only reads nodeName of a
  // console argument when it builds a RemoteObject description for an inspector session
  // that enabled Runtime (measured: 0 calls in a Chromium with no CDP client, ~2-3 calls
  // per probe under Playwright). The classic Error.stack getter no longer fires in Chrome 145.
  let consoleGetterCalls = 0;
  let probes = 0;
  function probe() {
    probes++;
    const el = D.createElement('div');
    Object.defineProperty(el, 'nodeName', {
      configurable: true,
      get() { consoleGetterCalls++; return 'LAB-WITNESS-PROBE'; },
    });
    debug.call(C, '[lab-witness] probe', el);
  }

  // ---- events ----
  const MAX_EVENTS = 300;
  const events = [];
  const eventCounts = {};
  const untrusted = {};
  const target0 = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  function count(e) {
    eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    if (!e.isTrusted) untrusted[e.type] = (untrusted[e.type] || 0) + 1;
  }
  function onEvent(e) {
    count(e);
    if (e.type === 'dragover') return;
    const entry = { t: now(), type: e.type, target: descEl(target0(e)), trusted: e.isTrusted };
    if (e.type === 'keydown') {
      entry.key = e.key && e.key.length === 1 ? (e.key === ' ' ? 'Space' : 'char') : e.key;
      const mods = [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
      if (mods.length) entry.mods = mods.join('+');
    } else if (e.type === 'input') {
      entry.inputType = e.inputType || null;
    } else if ('clientX' in e) {
      entry.x = Math.round(e.clientX);
      entry.y = Math.round(e.clientY);
      entry.button = e.button;
    }
    if (events.length >= MAX_EVENTS) events.shift();
    events.push(entry);
  }
  for (const type of ['click', 'dblclick', 'contextmenu', 'auxclick', 'pointerdown', 'mousedown', 'keydown', 'input', 'change', 'dragstart', 'dragover', 'drop', 'dragend', 'paste', 'copy']) {
    listen.call(W, type, onEvent, { capture: true, passive: true });
  }

  // ---- pointer path ----
  let movesSinceClick = 0;
  let enteredSinceClick = new Set();
  let totalMoves = 0;
  const clicks = [];
  listen.call(W, 'mousemove', (e) => { count(e); movesSinceClick++; totalMoves++; }, { capture: true, passive: true });
  listen.call(W, 'mouseover', (e) => { enteredSinceClick.add(target0(e)); }, { capture: true, passive: true });
  listen.call(W, 'click', (e) => {
    if (clicks.length >= 100) clicks.shift();
    clicks.push({ t: now(), target: descEl(target0(e)), moves: movesSinceClick, entered: enteredSinceClick.size, trusted: e.isTrusted, x: Math.round(e.clientX), y: Math.round(e.clientY) });
    movesSinceClick = 0;
    enteredSinceClick = new Set();
  }, { capture: true, passive: true });

  // ---- typing cadence ----
  const typing = new Map();
  listen.call(W, 'keydown', (e) => {
    const field = descEl(target0(e));
    let rec = typing.get(field);
    if (!rec) { rec = { keydowns: 0, untrusted: 0, last: null, gaps: [] }; typing.set(field, rec); }
    rec.keydowns++;
    if (!e.isTrusted) rec.untrusted++;
    if (rec.last != null && rec.gaps.length < 2000) rec.gaps.push(e.timeStamp - rec.last);
    rec.last = e.timeStamp;
  }, { capture: true, passive: true });
  function typingReport() {
    const out = {};
    for (const [field, rec] of typing) {
      const g = rec.gaps.slice().sort((a, b) => a - b);
      out[field] = {
        keydowns: rec.keydowns,
        untrusted: rec.untrusted,
        medianGapMs: g.length ? Math.round(g[(g.length - 1) >> 1] * 10) / 10 : null,
        minGapMs: g.length ? Math.round(g[0] * 10) / 10 : null,
      };
    }
    return out;
  }

  // ---- scrolling ----
  const scrolls = { wheel: 0, wheelTrusted: 0, wheelUntrusted: 0, scrollEvents: 0, containers: {} };
  listen.call(W, 'wheel', (e) => {
    count(e);
    scrolls.wheel++;
    if (e.isTrusted) scrolls.wheelTrusted++; else scrolls.wheelUntrusted++;
  }, { capture: true, passive: true });
  listen.call(W, 'scroll', (e) => {
    const t = e.target;
    const isDoc = t === D || t === W;
    const key = isDoc ? 'document' : descEl(t);
    let c = scrolls.containers[key];
    if (!c) { c = scrolls.containers[key] = { events: 0, x: 0, y: 0, maxY: 0, maxX: 0 }; }
    c.events++;
    c.x = Math.round(isDoc ? W.scrollX : t.scrollLeft);
    c.y = Math.round(isDoc ? W.scrollY : t.scrollTop);
    c.maxX = Math.max(c.maxX, c.x);
    c.maxY = Math.max(c.maxY, c.y);
    scrolls.scrollEvents++;
  }, { capture: true, passive: true });

  // ---- visibility / focus ----
  const visibility = { initial: D.visibilityState, changes: [], focusSamples: [], hiddenMs: 0 };
  let hiddenSince = D.visibilityState === 'hidden' ? now() : null;
  listen.call(D, 'visibilitychange', () => {
    const t = now();
    visibility.changes.push({ t, state: D.visibilityState });
    if (D.visibilityState === 'hidden') hiddenSince = t;
    else if (hiddenSince != null) { visibility.hiddenMs += t - hiddenSince; hiddenSince = null; }
    if (D.visibilityState === 'hidden') send();
  }, { capture: true });

  // ---- report + beacon ----
  let seq = 0;
  function report() {
    drain(null);
    scanGlobals();
    scanSheets();
    const t = now();
    if (visibility.focusSamples.length >= 600) visibility.focusSamples.shift();
    visibility.focusSamples.push({ t, hasFocus: D.hasFocus(), state: D.visibilityState });
    const presentGlobals = Object.getOwnPropertyNames(W).filter((k) => foreignGlobalsSeen.has(k));
    return {
      v: 1,
      tag,
      instance,
      seq: ++seq,
      url: location.href,
      origin: location.origin,
      frame: frameKind,
      title: D.title,
      startedAtEpochMs,
      uptimeMs: t,
      readyState: D.readyState,
      foreignMutationCount: foreignCount,
      foreignMutationsByType: foreignByType,
      foreignMutations,
      ownMutations,
      foreignGlobals: Array.from(foreignGlobalsSeen),
      foreignGlobalsPresent: presentGlobals,
      automationGlobals: Array.from(automationSeen),
      patchedApis: Array.from(patchedSeen),
      stylesheetsAdded: sheetsAdded,
      webdriver: navigator.webdriver,
      consoleGetterCalls,
      probes,
      events: { counts: eventCounts, untrusted, list: events },
      pointer: { mousemoves: totalMoves, clicks },
      typing: typingReport(),
      scrolls,
      visibility: {
        initial: visibility.initial,
        current: D.visibilityState,
        changes: visibility.changes,
        hiddenMs: visibility.hiddenMs + (hiddenSince != null ? t - hiddenSince : 0),
        focusSamples: visibility.focusSamples,
      },
    };
  }
  function send() {
    const r = report();
    let body = JSON.stringify(r);
    if (body.length > 60000) {
      r.truncated = true;
      r.events = { counts: eventCounts, untrusted, list: events.slice(-40) };
      r.foreignMutations = foreignMutations.slice(0, 40);
      r.pointer = { mousemoves: totalMoves, clicks: clicks.slice(-30) };
      r.visibility.focusSamples = visibility.focusSamples.slice(-30);
      body = JSON.stringify(r);
    }
    try { sendBeacon.call(navigator, '/witness', body); } catch { /* page is unloading or beacon quota exceeded */ }
  }

  setIntervalOrig(() => { probe(); scanGlobals(); }, 500);
  setIntervalOrig(send, 1000);
  listen.call(W, 'pagehide', send, { capture: true });

  // ---- page API ----
  function on(target, type, fn, opts) {
    const h = function (e) { return m(() => fn.call(this, e)); };
    target.addEventListener(type, h, opts);
    return () => target.removeEventListener(type, h, opts);
  }
  const later = (ms, fn) => setTimeoutOrig(() => m(fn), ms);
  const every = (ms, fn) => setIntervalOrig(() => m(fn), ms);
  const frame = (fn) => rafOrig((ts) => m(() => fn(ts)));
  function editable(el) { editableRoots.add(el); markTree(el); return el; }
  function nativeAttr(el, names) {
    let s = nativeAttrs.get(el);
    if (!s) nativeAttrs.set(el, (s = new Set()));
    for (const n of names) s.add(n);
    return el;
  }
  function observeShadow(root) {
    shadowRoots.push(root);
    observe(root);
    for (const el of root.querySelectorAll('[data-lab-editable]')) editable(el);
    return root;
  }
  function ownSheet(sheet) { ownSheets.add(sheet); return sheet; }
  function declareGlobals(...names) { for (const n of names) declaredGlobals.add(n); }

  const lab = Object.freeze({ m, on, later, every, frame, editable, nativeAttr, observeShadow, ownSheet, declareGlobals, report, tag, instance });
  Object.defineProperty(W, 'lab', { value: lab, enumerable: false, configurable: false, writable: false });
})();
