import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement window.matchMedia. Several places in this app now
// read `prefers-reduced-motion` at runtime (App.tsx's own scrollToId(), and
// lib/motion.ts's prefersReducedMotion(), used by the data-viz animations
// wave's exit-delay logic) -- a single shared default here means every test
// file gets a safe `matches: false` stub without needing its own per-file
// polyfill (App.test.tsx's existing `beforeEach` polyfill still works fine
// alongside this -- its own `window.matchMedia ?? (...)` becomes a no-op
// once this file has already defined it, which is harmless).
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// WAVE 6f item 8 (2026-08-11): `window.localStorage` -- the persistence
// lib/preferences.ts's loadSavedPlaces()/saveSavedPlaces() now use -- is
// `undefined` under this project's installed Node/vitest-environment-jsdom
// combination (confirmed live: Node's own newer built-in, experimental
// `localStorage` global throws without a `--localstorage-file` flag, and
// something in that resolution order leaves `window.localStorage` unset
// rather than jsdom's real implementation). Same fix shape as
// window.matchMedia above: a minimal, real (not mocked-away) in-memory
// Storage implementation, shared across every test file, so
// loadSavedPlaces/saveSavedPlaces exercise their real get/set/parse logic
// under test instead of silently hitting their own catch-and-no-op path
// (which is correct PRODUCTION behavior for a genuinely broken
// localStorage, but would make every persistence test a false-positive
// "passes because it does nothing" here).
if (typeof window !== "undefined" && !window.localStorage) {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", { value: memoryStorage, configurable: true });
}

// WAVE 6f item 3 (2026-08-11): jsdom implements no real rendering engine,
// so `Element.prototype.animate` (the Web Animations API,
// CellReportView.tsx's ExpandableTile now uses it to play the tile-
// expansion spring -- see that file's own comment) doesn't exist there at
// all -- confirmed live: every test that expands a tile crashed with
// "el.animate is not a function" before this stub existed. Same fix shape
// as window.matchMedia/window.localStorage above: a minimal but REAL
// implementation of the one piece of the Animation interface this
// codebase's own code actually calls (`.cancel()`, checked via
// `animRef.current?.cancel()`), not a full WAAPI polyfill -- jsdom can't
// meaningfully play keyframes without a real compositor to run them on
// regardless of how complete a stub this is, so there is no real behavior
// to test-cover beyond "calling animate() doesn't throw, and the returned
// handle is cancellable."
if (typeof Element !== "undefined" && !Element.prototype.animate) {
  Element.prototype.animate = function (): Animation {
    return {
      cancel: () => {},
      finish: () => {},
      pause: () => {},
      play: () => {},
      reverse: () => {},
      updatePlaybackRate: () => {},
      persist: () => {},
      commitFinish: () => {},
      finished: Promise.resolve() as unknown as Promise<Animation>,
      ready: Promise.resolve() as unknown as Promise<Animation>,
      currentTime: 0,
      effect: null,
      id: "",
      pending: false,
      playState: "finished",
      playbackRate: 1,
      replaceState: "active",
      startTime: null,
      timeline: null,
      oncancel: null,
      onfinish: null,
      onremove: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as unknown as Animation;
  };
}
