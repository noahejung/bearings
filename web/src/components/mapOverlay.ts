// What goes into the three address-scoped map sources -- building
// footprints, street centrelines, subway/PATH lines -- and the station
// markers beside them, as a pure function of `GET /api/map`'s payload.
//
// Its own module rather than more helpers inside MapView.tsx for the reason
// buildingRecord.ts and buildingPhoto.ts are: MapView.tsx imports
// maplibre-gl, which needs a real WebGL context, so nothing in that file is
// reachable from a jsdom test. The decision below IS the thing that needed
// a test.
//
// THE RULE THIS FILE HOLDS: **these three sources are address-scoped, so
// with no address they are empty.** Not "left as they were" -- empty. The
// map creates all three with EMPTY_FC and every other geometry helper in
// MapView.tsx already returns EMPTY_FC when its own input is missing
// (routeLineGeoJSON, destinationRingsGeoJSON, tileHighlightGeoJSON). These
// three were the exception, and the exception was a bug: see
// addressOverlaySources() below.

import type { FeatureCollection } from "geojson";

import type { MapGeometry, MapStation } from "../types";

export const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

// LAYOUT-V3 WAVE 1e: every footprint carries its own real bbl/year/era/
// residential/hazard properties (MapGeometry's MapBuilding, see types.ts's
// own comment for the None-vs-0 rules) -- mapStyle.ts's per-building layers
// read `residential`/`hazard_class_c` straight off these properties (via
// `["get", ...]`), and the click/hover handlers in MapView read all five off
// whichever feature `queryRenderedFeatures`/the mousemove hit returns. A
// real numeric top-level `id` (index into this one fetch's own array,
// stable only within it -- same convention citywideCellsGeoJSON() already
// uses, same reason: MapLibre's `setFeatureState` only works against a
// real numeric GeoJSON feature id) drives the hover fill in mapStyle.ts's
// buildOverlayLayers().
export function buildingsGeoJSON(geo: MapGeometry): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: geo.buildings.map((b, i) => ({
      type: "Feature",
      id: i,
      properties: {
        bbl: b.bbl,
        year_built: b.year_built,
        era: b.era,
        residential: b.residential,
        hazard_class_c: b.hazard_class_c,
      },
      geometry: {
        type: "Polygon",
        coordinates: [b.coords.map(([lat, lng]): [number, number] => [lng, lat])],
      },
    })),
  };
}

export function streetsGeoJSON(geo: MapGeometry): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: geo.streets.map((s) => ({
      type: "Feature",
      properties: { rank: s.rank },
      geometry: {
        type: "LineString",
        coordinates: s.coords.map(([lat, lng]): [number, number] => [lng, lat]),
      },
    })),
  };
}

export function subwayGeoJSON(geo: MapGeometry): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: geo.subway_lines.map((line) => ({
      type: "Feature",
      properties: { route: line.route },
      geometry: {
        type: "LineString",
        coordinates: line.coords.map(([lat, lng]): [number, number] => [lng, lat]),
      },
    })),
  };
}

export interface AddressOverlay {
  buildings: FeatureCollection;
  streets: FeatureCollection;
  subway: FeatureCollection;
  stations: MapStation[];
}

/** Everything the three address-scoped sources and the station markers
 *  should hold for a given `GET /api/map` payload -- and empty for `null`.
 *
 *  `null` is a real, routine state: App.handleCellClick() calls
 *  `setSearchedAddress(null)` on every bare grid click, so a reader who
 *  searches an address and then clicks anywhere that is not a building has
 *  no searched address any more.
 *
 *  MapView's `geo` effect used to close the open card and RETURN at that
 *  point, before it reached the three `setData()` calls, so the previous
 *  address's footprints, streets, subway lines and station markers all
 *  stayed on the map. Two things followed, both reproduced live on
 *  2026-09-07 against the real app:
 *
 *  1. The stale footprints stayed CLICKABLE, and `geoRef.current` was by
 *     then `null`, so `showBuildingInfo()` looked up
 *     `geoRef.current.sources.building_age` / `.hazards`, got `undefined`
 *     for both, and rendered a card showing a year built and a hazard count
 *     with **no source line at all**. Measured: the control card carried
 *     "NYC PLUTO · NYC HPD" and the stale card carried nothing.
 *  2. The map showed one address's overlay while the search field showed a
 *     different, reverse-geocoded place.
 *
 *  This also contradicted MapView.tsx's own module docstring, which says
 *  `address` may be null "in which case both are simply empty, never
 *  fetched, never blocking."
 */
export function addressOverlaySources(geo: MapGeometry | null): AddressOverlay {
  if (!geo) {
    return { buildings: EMPTY_FC, streets: EMPTY_FC, subway: EMPTY_FC, stations: [] };
  }
  return {
    buildings: buildingsGeoJSON(geo),
    streets: streetsGeoJSON(geo),
    subway: subwayGeoJSON(geo),
    stations: geo.stations,
  };
}
