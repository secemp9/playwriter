// Shared helpers for Browser Lab pages. Every DOM change made by page code goes
// through lab.m (directly or via on/later/every/frame) so the witness can tell
// the page's own mutations from an automation tool's.
const lab = window.lab;

export const { m, on, later, every, frame } = lab;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const TAG = new URLSearchParams(location.search).get('tag');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LAB_PORTS = new Set(['47101', '47102']);

/** Same-origin/lab URL with the current ?tag= carried over (so popups, frames and next pages report under the same tag). */
export function withTag(href) {
  const u = new URL(href, location.href);
  if (TAG && LAB_PORTS.has(u.port) && !u.searchParams.has('tag')) u.searchParams.set('tag', TAG);
  return u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
}

/** Rewrites lab links under root so they keep the tag. Download links are left untouched. */
export function tagLinks(root = document) {
  if (!TAG) return;
  m(() => {
    for (const a of root.querySelectorAll('a[href]')) {
      if (a.hasAttribute('download')) continue;
      const raw = a.getAttribute('href');
      if (raw.startsWith('#')) continue;
      const next = withTag(raw);
      if (next !== raw) a.setAttribute('href', next);
    }
  });
}

export function setText(el, text) {
  m(() => {
    if (el.textContent !== text) el.textContent = text;
  });
}

/** Status toast: role=status container #toasts must exist on the page. Removed after ms. */
export function toast(text, ms = 2000) {
  const host = $('#toasts');
  let el;
  m(() => {
    el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    host.append(el);
  });
  later(ms, () => el.remove());
}

/** Appends a line to a list (activity logs). */
export function logLine(list, text) {
  m(() => {
    const li = document.createElement('li');
    li.textContent = text;
    list.append(li);
  });
}

export const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
