// Regression test for the stale-overlay bug: MapView's `geo` effect used to
// return early when the searched address went away, leaving the previous
// address's footprints drawn, clickable, and -- once `geoRef.current` was
// null -- able to open a card carrying a year built and a hazard count with
// no source line at all.
//
// Reproduced live against the running app before the fix (Playwright,
// 2026-09-07): search "350 5th Ave, Manhattan", click a residential
// footprint (card cites "NYC PLUTO · NYC HPD"), click a point that is not a
// footprint, then click a footprint that is still drawn -- that card cited
// neither. Screenshots in
// Claude/agent-reports/screenshots/2026-09-07-bearings-building-photo/bare-click-bug.

import { describe, expect, it } from "vitest";
import {
  addressOverlaySources,
  buildingsGeoJSON,
  EMPTY_FC,
  streetsGeoJSON,
  subwayGeoJSON,
} from "./mapOverlay";
import type { MapGeometry } from "../types";

// A minimal but real-shaped GET /api/map payload: one residential footprint,
// one street, one subway line, one station.
const GEO: MapGeometry = {
  subject: { lat: 40.748441, lng: -73.985656, bbl: "1008350041", cell: "892a100d2d7ffff" },
  bbox: { west: -73.99, south: 40.74, east: -73.98, north: 40.75 },
  buildings: [
    {
      bbl: "1008350041",
      coords: [
        [40.7484, -73.9857],
        [40.7485, -73.9857],
        [40.7485, -73.9856],
        [40.7484, -73.9856],
      ],
      year_built: 1931,
      era: "prewar",
      residential: true,
      hazard_class_c: 0,
    },
  ],
  streets: [
    {
      rank: 1,
      coords: [
        [40.748, -73.986],
        [40.749, -73.985],
      ],
    },
  ],
  subway_lines: [
    {
      route: "B",
      shape_id: "B..N",
      coords: [
        [40.747, -73.987],
        [40.75, -73.984],
      ],
    },
  ],
  stations: [{ name: "34 St-Herald Sq", lat: 40.7496, lng: -73.9878, routes: ["B", "D"] }],
  sources: {},
} as unknown as MapGeometry;

describe("addressOverlaySources", () => {
  it("draws the searched address's own geometry", () => {
    const overlay = addressOverlaySources(GEO);
    expect(overlay.buildings.features).toHaveLength(1);
    expect(overlay.streets.features).toHaveLength(1);
    expect(overlay.subway.features).toHaveLength(1);
    expect(overlay.stations).toHaveLength(1);
    // The footprint carries the properties the click handler reads.
    expect(overlay.buildings.features[0].properties).toMatchObject({
      bbl: "1008350041",
      year_built: 1931,
      residential: true,
      hazard_class_c: 0,
    });
    // GeoJSON is [lng, lat]; the API is [lat, lng].
    expect(overlay.buildings.features[0].geometry).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [-73.9857, 40.7484],
          [-73.9857, 40.7485],
          [-73.9856, 40.7485],
          [-73.9856, 40.7484],
        ],
      ],
    });
  });

  it("EMPTIES all three sources and the station list when there is no address", () => {
    // THE REGRESSION. A bare grid click sets the searched address to null;
    // if this returns the previous payload's geometry -- or if the caller
    // simply never writes it -- the last search's footprints stay on the map
    // and stay clickable, and the card that opens on one of them has no
    // `geo` to cite its sources from.
    const overlay = addressOverlaySources(null);
    expect(overlay.buildings).toEqual(EMPTY_FC);
    expect(overlay.streets).toEqual(EMPTY_FC);
    expect(overlay.subway).toEqual(EMPTY_FC);
    expect(overlay.stations).toEqual([]);
  });

  it("empties them for a null address even right after a real one", () => {
    // The order that matters: a populated overlay must not be able to
    // survive into the no-address state.
    expect(addressOverlaySources(GEO).buildings.features).toHaveLength(1);
    expect(addressOverlaySources(null).buildings.features).toHaveLength(0);
  });

  it("matches the empty collection the map creates these sources with", () => {
    // MapView's effect 2 calls addSource(..., { data: EMPTY_FC }) for all
    // three, so "no address" restores exactly the state the map booted in
    // rather than inventing a fourth one.
    expect(EMPTY_FC).toEqual({ type: "FeatureCollection", features: [] });
  });
});

describe("the geometry builders", () => {
  it("gives every footprint a numeric id, which setFeatureState requires", () => {
    const fc = buildingsGeoJSON({
      ...GEO,
      buildings: [GEO.buildings[0], { ...GEO.buildings[0], bbl: "1008350042" }],
    });
    expect(fc.features.map((f) => f.id)).toEqual([0, 1]);
  });

  it("flips [lat, lng] to GeoJSON's [lng, lat] for streets and subway alike", () => {
    const street = streetsGeoJSON(GEO).features[0].geometry;
    const subway = subwayGeoJSON(GEO).features[0].geometry;
    expect(street).toMatchObject({
      type: "LineString",
      coordinates: [
        [-73.986, 40.748],
        [-73.985, 40.749],
      ],
    });
    expect(subway).toMatchObject({
      type: "LineString",
      coordinates: [
        [-73.987, 40.747],
        [-73.984, 40.75],
      ],
    });
  });
});
