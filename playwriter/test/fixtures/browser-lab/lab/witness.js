// Stand-in for the Browser Lab's page-side witness (/tmp/browser-lab/pages/lab/witness.js).
// The lab pages call `window.lab` helpers to tag their own DOM changes; the tests only need
// the helpers to run the page code, not the witness's recording and beacons.
;(() => {
  const m = (fn) => fn()
  function on(target, type, fn, opts) {
    const h = function (e) {
      return fn.call(this, e)
    }
    target.addEventListener(type, h, opts)
    return () => target.removeEventListener(type, h, opts)
  }
  const later = (ms, fn) => setTimeout(fn, ms)
  const every = (ms, fn) => setInterval(fn, ms)
  const frame = (fn) => requestAnimationFrame(fn)
  const identity = (x) => x
  const lab = Object.freeze({
    m,
    on,
    later,
    every,
    frame,
    editable: identity,
    nativeAttr: identity,
    observeShadow: identity,
    ownSheet: identity,
    declareGlobals: () => {},
    tag: null,
    instance: 'fixture',
  })
  Object.defineProperty(window, 'lab', { value: lab, enumerable: false, configurable: false, writable: false })
})()
