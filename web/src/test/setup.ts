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
