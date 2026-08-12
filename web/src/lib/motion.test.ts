import { afterEach, describe, expect, it, vi } from "vitest";
import {
  motionDelay,
  MOTION_BASE_MS,
  MOTION_EXPAND_MS,
  MOTION_FAST_MS,
  prefersReducedMotion,
  springProgress,
} from "./motion";

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prefersReducedMotion / motionDelay", () => {
  it("reads the real prefers-reduced-motion media query, not a guessed default", () => {
    stubReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it("motionDelay passes the real duration through under normal motion", () => {
    stubReducedMotion(false);
    expect(motionDelay(150)).toBe(150);
    expect(motionDelay(MOTION_FAST_MS)).toBe(MOTION_FAST_MS);
  });

  it("motionDelay collapses to 0 under prefers-reduced-motion: reduce -- 'values snap, no motion'", () => {
    stubReducedMotion(true);
    expect(motionDelay(150)).toBe(0);
    expect(motionDelay(MOTION_BASE_MS)).toBe(0);
  });
});

describe("timing tokens", () => {
  // Not a very meaningful assertion on its own, but it does pin the actual
  // exported numbers this wave's report cites -- a future edit that
  // silently changes one of these without updating the report/CSS mirror
  // fails this test instead of drifting unnoticed.
  it("exports the real timing tokens this wave's motion spec calls for", () => {
    expect(MOTION_FAST_MS).toBe(150);
    expect(MOTION_BASE_MS).toBe(200);
  });
});

// WAVE 6f item 3 (2026-08-11): springProgress() is a real under-damped
// harmonic oscillator (zeta=0.38, omega=17 rad/s -- see its own comment for
// the full derivation), not an eyeballed curve -- these are direct
// regression guards on its actual shape (starts at 0, overshoots, decays
// through real diminishing extrema, settles near 1), pinning the exact
// numbers this wave's own report cites so a future tuning pass can't
// silently drift the "three diminishing oscillations" claim without this
// test noticing.
describe("springProgress (the expressive tile-expansion spring)", () => {
  it("starts at 0 and ends within 3% of the settled target 1", () => {
    expect(springProgress(0)).toBeCloseTo(0, 5);
    expect(springProgress(1)).toBeGreaterThan(0.97);
    expect(springProgress(1)).toBeLessThan(1.03);
  });

  it("overshoots past 1 at its first peak (~1/3 through the curve)", () => {
    const peak = springProgress(0.333);
    expect(peak).toBeGreaterThan(1.2); // real peak measured ~1.275
    expect(peak).toBeLessThan(1.35);
  });

  it("undershoots below 1 at its first trough (~2/3 through the curve) -- a real second extremum, not a single bounce", () => {
    const trough = springProgress(0.667);
    expect(trough).toBeLessThan(1);
    expect(trough).toBeGreaterThan(0.85); // real trough measured ~0.924
  });

  it("each successive extremum is smaller than the last -- genuinely decaying, never growing or sustaining", () => {
    const peak = Math.abs(springProgress(0.333) - 1);
    const trough = Math.abs(springProgress(0.667) - 1);
    const thirdBump = Math.abs(springProgress(0.917) - 1);
    expect(trough).toBeLessThan(peak);
    expect(thirdBump).toBeLessThan(trough);
  });

  it("the animation duration is long enough to actually show 3 extrema, not a jump-cut (Material's own 400-600ms 'emphasized' range for expressive/large transitions)", () => {
    expect(MOTION_EXPAND_MS).toBeGreaterThanOrEqual(400);
    expect(MOTION_EXPAND_MS).toBeLessThanOrEqual(600);
  });
});
