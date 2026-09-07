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

// WAVE 6f item 3 (2026-08-11, Noah live-use: "feels like a generic page
// open ... i want a little shake to it almost i.e. more dramatic
// expressive motion curves"). A DELIBERATE REVERSAL of Wave 6d's own
// --ease-spring decision (index.css -- that single-overshoot cubic-bezier
// token is retired outright by this wave, not kept alongside this one:
// its only consumer was the tile FLIP transition this wave replaces) --
// that wave chose a ~1.25%-overshoot cubic-bezier specifically to stay
// "bouncy... not cartoon."
// Noah's live-use verdict on the shipped result was the opposite problem:
// too restrained to read as anything but a generic resize. This tile
// expansion is this app's own ONE deliberately expressive "hero" motion
// moment (SPEC-layout-v3.md's tmux-style tile expansion, Wave 6d) --
// documented as a two-tier policy, not a global loosening: every OTHER
// motion in this app (hover fades, bar fills, value settles -- MOTION_FAST_
// MS/MOTION_BASE_MS above, --motion-bar in index.css) stays exactly as
// restrained as before. Nothing here changes those.
//
// THE PHYSICS, not eyeballed: a real under-damped harmonic oscillator,
// y(t) = 1 - e^(-zeta*omega*t) * (cos(omega_d*t) + (zeta*omega/omega_d) *
// sin(omega_d*t)), omega_d = omega*sqrt(1-zeta^2) -- the same equation
// (and the same stiffness/damping/mass -> zeta/omega conversion) iOS's
// UISpringTimingParameters and Framer Motion's spring type both implement
// under the hood; CellReportView.tsx's ExpandableTile samples THIS
// function directly (springProgress() below) to build a Web Animations
// API keyframe list, rather than approximating it with a single CSS
// cubic-bezier (a cubic-bezier is monotonic by construction -- it
// physically cannot express more than one overshoot, which is exactly why
// Wave 6d's --ease-spring reads as one small bounce, not "a little shake").
//
// PARAMETERS, tuned (Node script, 2026-08-11, sampling this exact formula
// at 24 steps before picking these numbers, not guessed): zeta=0.38
// (damping ratio -- the standard "playful, controlled" range is 0.3-0.5;
// below ~0.3 starts reading as loose/uncontrolled, above ~0.5 loses the
// third bump), omega=17 rad/s (natural frequency, chosen so the curve
// settles within the duration budget below). This combination produces
// three real, diminishing extrema before settling: +27.5% overshoot (peak
// ~33% through the curve), -7.6% undershoot (trough ~67% through), +2.1%
// overshoot (a small third bump ~92% through) -- a real decay ratio of
// roughly 1/3.6 per half-cycle, the correct shape for an under-damped
// system (each successive peak is smaller by a constant ratio, never
// grows, never oscillates forever). Reference: Thomas & Johnston, "The
// Illusion of Life" (1981) -- Disney's "Follow Through and Overlapping
// Action" principle (parts of a moving object continue and settle at
// slightly different times rather than arriving dead-stopped) is exactly
// what this decaying-oscillation shape gives the tile's grow/shrink.
export const SPRING_ZETA = 0.38;
export const SPRING_OMEGA = 17;

// Duration: 600ms, up from Wave 6d's 260ms -- a real spring showing three
// extrema needs more time to read as controlled motion rather than a
// jump-cut; sub-400ms is roughly the ceiling at which a human eye can
// still track more than one bounce as "bouncy" rather than "glitchy" (the
// same reasoning Material Design's own "emphasized" duration tier, 400-
// 600ms for large/expressive transitions, is built around, versus its
// 200-300ms "standard" tier for utilitarian ones -- this app's OWN
// MOTION_BASE_MS/MOTION_FAST_MS above already sit in that "standard"
// range, which is the concrete two-tier split this comment's own opening
// paragraph names). Close/collapse reuses the identical curve+duration
// (index.css's own .tile--floating rule) -- deliberately symmetric, not a
// separately-tuned "closing is faster" pass; both directions are equally
// this app's one hero moment.
export const MOTION_EXPAND_MS = 600;

// The rotational "shake" itself (SPEC's own "optional <=1deg rotational
// micro-wobble") -- a Disney "Secondary Action": a smaller supporting
// motion that reinforces the primary one (the scale/translate grow)
// without competing with it, which is why it shares the EXACT same decay
// envelope as the spring above (springProgress(t) - 1, centred on 0
// instead of 1) rather than an independently-tuned wobble -- two unrelated
// oscillation rates on the same object read as noise, not "alive."
export const SPRING_ROTATION_DEG = 1;

// Samples the real under-damped spring equation described above at
// `progress` (0-1, a fraction of the animation's own total duration) --
// returns a value that starts at 0, overshoots past 1, oscillates, and
// settles at 1 (never returned as a rounded/clamped value here; the last
// real Web Animations API keyframe this feeds is what pins the FINAL value
// to exactly 1/0, not this function -- see ExpandableTile's own comment).
export function springProgress(progress: number): number {
  const wd = SPRING_OMEGA * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);
  const t = progress * (MOTION_EXPAND_MS / 1000);
  return (
    1 -
    Math.exp(-SPRING_ZETA * SPRING_OMEGA * t) *
      (Math.cos(wd * t) + ((SPRING_ZETA * SPRING_OMEGA) / wd) * Math.sin(wd * t))
  );
}

// A 2D affine transform expressed as its component parts (never a raw
// matrix string in this module's own public surface -- CellReportView.tsx
// is the one place a `matrix(...)` string ever gets parsed, decomposing a
// live `getComputedStyle().transform` read to capture a tile's CURRENT
// rendered position when an in-flight spring gets interrupted).
export interface TileTransform {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

const SPRING_KEYFRAME_STEPS = 24;

// The one place this module builds a real `transform` string, from a real
// sampled point on springProgress()'s own curve -- ExpandableTile calls
// this once per animate() to build the whole keyframe list (never per
// frame; Web Animations API interpolates LINEARLY between these discrete
// keyframes itself, which is why springProgress() needs enough steps
// (SPRING_KEYFRAME_STEPS) to already carry the curve's actual shape here,
// not a plain start/end pair left for the browser's own easing to invent
// -- a linear `transform` interpolation between two plain endpoints could
// never produce an overshoot at all, single-bounce or otherwise).
function transformAt(from: TileTransform, to: TileTransform, spring: number): string {
  const tx = from.tx + (to.tx - from.tx) * spring;
  const ty = from.ty + (to.ty - from.ty) * spring;
  const sx = from.sx + (to.sx - from.sx) * spring;
  const sy = from.sy + (to.sy - from.sy) * spring;
  // Centred on 0 (not `to`'s own rotation, which is always 0 -- an
  // expanded/collapsed tile is never permanently tilted) and decays to 0
  // as `spring` settles to 1 -- see SPRING_ROTATION_DEG's own comment for
  // why this shares springProgress()'s exact envelope instead of an
  // independently-tuned wobble.
  const rotateDeg = SPRING_ROTATION_DEG * (spring - 1);
  return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)}) rotate(${rotateDeg.toFixed(3)}deg)`;
}

/** The full Web Animations API keyframe list for one spring run, from a
 * tile's CURRENT transform to its TARGET transform (either direction --
 * opening (small grid cell -> full footprint) and closing (full footprint
 * -> small grid cell) call this identically, just with `from`/`to`
 * swapped, which is why the curve is symmetric rather than separately
 * tuned per direction). The literal last element is forced to `to` at
 * spring progress exactly 1 (not whatever springProgress(1) itself
 * returns, ~0.98-1.03 depending on rounding) -- Web Animations API's own
 * `fill: "forwards"` holds this exact last keyframe after the animation
 * ends, so the tile must be pixel-exact at its real target, never a
 * fraction of a percent off from an unclamped physics sample. */
export function buildSpringKeyframes(from: TileTransform, to: TileTransform): Keyframe[] {
  const frames: Keyframe[] = [];
  for (let i = 0; i <= SPRING_KEYFRAME_STEPS; i++) {
    const progress = i / SPRING_KEYFRAME_STEPS;
    const spring = i === SPRING_KEYFRAME_STEPS ? 1 : springProgress(progress);
    frames.push({ transform: transformAt(from, to, spring), offset: progress });
  }
  return frames;
}

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
