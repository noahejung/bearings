import { describe, expect, it } from "vitest";
import { percentileRank } from "./relativeScale";

// Same cases bearings/citywide.py's own test_citywide.py locks in for the
// Python percentile_rank() this ports -- parity between the two
// implementations of the same mean-rank method matters here, since the
// map applies this client-side to metrics the backend never percentile-
// ranks itself (only crime gets that treatment server-side).

describe("percentileRank", () => {
  it("places the sample median near 50", () => {
    expect(percentileRank([10, 20, 30, 40, 50], 30)).toBeCloseTo(50);
  });

  it("never collapses the extremes to a bare 0/100", () => {
    expect(percentileRank([10, 20, 30, 40, 50], 10)).toBeCloseTo(10);
    expect(percentileRank([10, 20, 30, 40, 50], 50)).toBeCloseTo(90);
  });

  it("splits ties evenly", () => {
    expect(percentileRank([1, 2, 2, 3], 2)).toBeCloseTo(50);
  });

  it("throws on an empty distribution", () => {
    expect(() => percentileRank([], 5)).toThrow();
  });
});
