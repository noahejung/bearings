import type { StyleSpecification } from "maplibre-gl";

// The tDR steel-set MapLibre style, authored ourselves (VISUAL.md §5,
// REVISED 2026-07-15): "we author the entire map style ourselves (land
// bone, water/parks steel, streets ink, labels in our grotesk), so the
// base is tDR, not someone else's look". Every colour here is one of the
// four locked tokens (web/src/styles/index.css's --bone/--ink/--steel/
// --red) -- no gradients, no third colour.
//
// Source-layer names (earth/water/landuse/roads) and their `kind` values
// are the real Protomaps Basemap v4 schema -- confirmed live 2026-07-15
// against docs.protomaps.com/basemaps/layers, not guessed. Deliberately
// NOT rendered from the basemap: `buildings` (this app draws its own real
// NYC building-footprint mass locally around the subject address --
// MapView's own overlay, sourced from NYC Open Data, not OSM) and `places`
// (city/neighbourhood name labels -- this app labels neighbourhoods from
// its own NTA data and precincts from its own NYPD data instead, both
// fetched via /api/citywide, so the map never shows two different label
// sets for the same idea). No `glyphs` key: nothing in this style uses a
// `symbol` layer with a `text-field` -- every text label on this map
// (subway routes, neighbourhood names, precinct numbers) is a real DOM
// element positioned with MapLibre's own screen-projection API
// (MapView.tsx), styled in this app's actual grotesk/mono fonts, not a
// pre-rendered glyph atlas that could only ever offer a generic sans.

const BONE = "#EDE9DE";
const INK = "#111111";
const STEEL = "#8A8D8F";

// Real Protomaps Basemap `landuse` `kind` values that read as green/open
// space -- steel, not a fifth colour, per VISUAL.md §2's "no colour
// outside the four".
const OPEN_SPACE_KINDS = [
  "park",
  "forest",
  "wood",
  "scrub",
  "grass",
  "meadow",
  "garden",
  "nature_reserve",
  "national_park",
  "protected_area",
  "cemetery",
  "golf_course",
  "recreation_ground",
  "zoo",
  "farmland",
  "farmyard",
  "orchard",
];

export function buildMapStyle(tilesUrl: string): StyleSpecification {
  return {
    version: 8,
    name: "bearings — tDR steel",
    sources: {
      basemap: {
        type: "vector",
        url: `pmtiles://${tilesUrl}`,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": BONE } },
      {
        id: "earth",
        type: "fill",
        source: "basemap",
        "source-layer": "earth",
        paint: { "fill-color": BONE },
      },
      {
        id: "open-space",
        type: "fill",
        source: "basemap",
        "source-layer": "landuse",
        filter: ["in", ["get", "kind"], ["literal", OPEN_SPACE_KINDS]],
        paint: { "fill-color": STEEL, "fill-opacity": 0.22 },
      },
      {
        id: "water",
        type: "fill",
        source: "basemap",
        "source-layer": "water",
        paint: { "fill-color": STEEL, "fill-opacity": 0.5 },
      },
      {
        id: "roads-minor",
        type: "line",
        source: "basemap",
        "source-layer": "roads",
        filter: ["in", ["get", "kind"], ["literal", ["minor_road", "path", "rail"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": INK,
          "line-opacity": 0.32,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.25, 16, 1],
        },
      },
      {
        id: "roads-major",
        type: "line",
        source: "basemap",
        "source-layer": "roads",
        filter: ["in", ["get", "kind"], ["literal", ["major_road", "highway"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": INK,
          "line-opacity": 0.72,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 16, 2.4],
        },
      },
    ],
  };
}
