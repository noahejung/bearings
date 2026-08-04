import { afterEach, describe, expect, it, vi } from "vitest";
import { motionDelay, MOTION_BASE_MS, MOTION_BAR_MS, MOTION_FAST_MS, prefersReducedMotion } from "./motion";

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
    expect(motionDelay(MOTION_BAR_MS)).toBe(0);
  });
});

describe("timing tokens", () => {
  // Not a very meaningful assertion on its own, but it does pin the actual
  // exported numbers this wave's report cites -- a future edit that
  // silently changes one of these without updating the report/CSS mirror
  // fails this test instead of drifting unnoticed.
  it("exports the three real timing tokens this wave's motion spec calls for", () => {
    expect(MOTION_FAST_MS).toBe(150);
    expect(MOTION_BASE_MS).toBe(200);
    expect(MOTION_BAR_MS).toBe(250);
  });
});
