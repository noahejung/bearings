// Motion timing tokens (data-viz animations wave, 2026-08-03) -- defined
// ONCE here and mirrored, not duplicated, in index.css's :root custom
// properties (--motion-fast/--motion-base/--motion-bar/--ease-out/--ease).
// CSS owns every actual transition/animation this wave adds (GPU-composited,
// off-thread -- the emil-design-eng skill's own "CSS vs JS" table: "CSS
// animations run off-thread; JS animations can drop frames"); this module
// exists ONLY for the few places plain JS still needs the identical number
// as a real value -- a setTimeout gating a delayed unmount (GettingAroundField's
// exit animation) -- so that number is never a second, independently-guessed
// magic literal that can drift from the CSS one over time.

export const MOTION_FAST_MS = 150; // exits/deletions -- "users forgive slow entry; they do not forgive slow exit" (emil-design-eng skill)
export const MOTION_BASE_MS = 200; // settle: tile/percentile value crossfade, row entrance
export const MOTION_BAR_MS = 250; // getting-around bar width/scale transitions

// Matches App.tsx's own scrollToId() convention exactly -- window.matchMedia
// called directly, no feature-detect wrapper, since that's this project's
// already-established pattern for reading this one media feature. jsdom's
// lack of a real implementation is handled centrally in test/setup.ts
// (a shared beforeEach polyfill), not per call site.
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// A motion-governed delay: the real duration under normal motion, or 0 under
// `prefers-reduced-motion: reduce` -- "values snap, no motion" (this wave's
// own binding requirement). Used wherever JS (not CSS) has to wait out a
// visual exit transition before actually unmounting something, so a
// reduced-motion user is never left looking at an already-invisible
// (CSS handles that half instantly) row that still occupies the DOM --
// and therefore tab order / assistive-tech focus -- for a real duration with
// nothing on screen to explain why.
export function motionDelay(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}
