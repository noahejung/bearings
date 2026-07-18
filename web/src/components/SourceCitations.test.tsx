import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AmenitiesCard } from "./AmenitiesCard";
import { SafetyCard } from "./SafetyCard";
import { TransitCard } from "./TransitCard";
import type { Amenities, Safety, Transit } from "../types";

// Regression guard for the three report cards that used to render real
// numbers (station names, walk minutes, anchor times, amenity counts,
// precinct crime) with no citation at all -- see SourceTag.tsx's own
// stated invariant, "a stat without a citation is a bug."

const TRANSIT_SOURCE = { name: "MTA GTFS + PATH GTFS", url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip" };
const AMENITIES_SOURCE = { name: "Overture Maps Places", url: "https://docs.overturemaps.org/guides/places/" };
const SAFETY_SOURCE = { name: "NYPD CompStat", url: "https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page" };

const TRANSIT: Transit = {
  nearest_stations: [{ name: "34 St-Herald Sq", routes: ["B", "D", "F", "M"], walk_minutes: 4 }],
  to_anchors: { midtown: 9, wtc: 21, downtown_brooklyn: 27, newport_path: 33 },
  unreachable_reason: { midtown: null, wtc: null, downtown_brooklyn: null, newport_path: null },
  caveat: "In-vehicle time plus a nominal transfer penalty.",
  source: TRANSIT_SOURCE,
};

const AMENITIES: Amenities = {
  counts: { grocery: 6, cafe: 21, bar: 9, restaurant: 74, pharmacy: 4, gym: 3, park: 1, laundry: 2 },
  source: AMENITIES_SOURCE,
};

const SAFETY_WITH_DATA: Safety = {
  precinct: 14,
  week_ending: "7/5/2026",
  robbery_ytd: 12,
  robbery_pct: -3.2,
  felony_assault_ytd: 8,
  felony_assault_pct: 1.1,
  total_ytd: 200,
  total_pct: 0.4,
  source: SAFETY_SOURCE,
};

const SAFETY_NO_MATCH: Safety = {};

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectSourceLink(name: string, url: string) {
  const link = screen.getByRole("link", { name: new RegExp(escapeRegExp(name)) });
  expect(link).toHaveAttribute("href", url);
}

describe("report cards cite a real source", () => {
  it("TransitCard renders a source citation", () => {
    render(<TransitCard transit={TRANSIT} />);
    expectSourceLink(TRANSIT_SOURCE.name, TRANSIT_SOURCE.url);
  });

  it("AmenitiesCard renders a source citation", () => {
    render(<AmenitiesCard amenities={AMENITIES} />);
    expectSourceLink(AMENITIES_SOURCE.name, AMENITIES_SOURCE.url);
  });

  it("SafetyCard renders a source citation when a precinct matched", () => {
    render(<SafetyCard safety={SAFETY_WITH_DATA} />);
    expectSourceLink(SAFETY_SOURCE.name, SAFETY_SOURCE.url);
  });

  it("SafetyCard renders no citation (and does not crash) when there is no precinct match", () => {
    render(<SafetyCard safety={SAFETY_NO_MATCH} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/We don.t have crime data/i)).toBeInTheDocument();
  });
});
