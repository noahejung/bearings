import type { StyleSpecification } from "maplibre-gl";
// @maplibre/maplibre-gl-style-spec is already a real transitive dependency
// of maplibre-gl (see maplibre-gl's own package.json + web/package-lock.json)
// and is what `map.addLayer()` calls internally to validate a layer before
// adding it to the map -- this import runs that exact same validator here,
// with no WebGL/browser required, so a regression like the one below fails
// a `vitest run` instead of shipping silently to prod again.
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { buildMapStyle, buildOverlayLayers } from "./mapStyle";

// FIXED 2026-07-15: four paint properties across three layers
// (streets-line's line-width/line-opacity, cells-fill's fill-opacity,
// cells-outline's line-opacity) nested a `["zoom"]` expression inside
// `*`/`case` instead of using it as the direct input to a top-level
// `interpolate`/`step`. MapLibre GL JS's style validator rejects that --
// but `map.addLayer()` swallows the rejection: it logs a `console.error`
// and simply never adds the layer, no thrown exception. That's why this
// shipped and passed every API/console-exception check while the zoom LOD
// and the metric-dropdown cell shading were both silently dead on prod.
// See `Claude/agent-reports/2026-07-15-bearings-live-map-smoke.md` (vault)
// for the live-browser repro that caught it.

describe("buildMapStyle (basemap)", () => {
  it("validates with zero errors against MapLibre's real style validator", () => {
    const style = buildMapStyle("https://example.com/tiles/nyc-basemap.pmtiles");
    expect(validateStyleMin(style)).toEqual([]);
  });
});

describe("buildOverlayLayers (MapView's own app layers)", () => {
  function styleWithOverlayLayers(): StyleSpecification {
    const layers = buildOverlayLayers();
    const sourceIds = [...new Set(layers.map((l) => ("source" in l ? l.source : undefined)).filter((s): s is string => typeof s === "string"))];
    return {
      version: 8,
      sources: Object.fromEntries(
        sourceIds.map((id) => [
          id,
          { type: "geojson" as const, data: { type: "FeatureCollection" as const, features: [] } },
        ]),
      ),
      layers,
    };
  }

  it("validates with zero errors against MapLibre's real style validator", () => {
    const errors = validateStyleMin(styleWithOverlayLayers());
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  it("every zoom-dependent paint expression uses ['zoom'] only as the direct input to a top-level interpolate/step", () => {
    // Belt-and-suspenders per the dispatch's suggestion: walk every paint
    // value directly, independent of validateStyleMin, and fail loudly if
    // a `["zoom"]` array shows up anywhere except as element [2] of a
    // top-level `["interpolate", ...]` / `["step", ...]` expression.
    for (const layer of buildOverlayLayers()) {
      if (!("paint" in layer) || !layer.paint) continue;
      for (const [prop, value] of Object.entries(layer.paint)) {
        if (!Array.isArray(value)) continue;
        const isTopLevelZoomExpr =
          (value[0] === "interpolate" || value[0] === "step") && Array.isArray(value[2]) && value[2][0] === "zoom";
        if (isTopLevelZoomExpr) continue;
        const json = JSON.stringify(value);
        expect(json.includes('"zoom"'), `${layer.id}.paint.${prop} nests ["zoom"] outside a top-level interpolate/step: ${json}`).toBe(
          false,
        );
      }
    }
  });

  it("still expresses the intended zoom LOD: minor streets/hex cells fade in, subject cell and arterial-tier lines always visible", () => {
    // Not just "valid syntax" -- confirms the restructuring in this fix
    // preserved VISUAL.md §5's actual behavior, not just made the layer
    // pass validation.
    const layers = buildOverlayLayers();
    const cellsFill = layers.find((l) => l.id === "cells-fill");
    const cellsOutline = layers.find((l) => l.id === "cells-outline");
    const streetsLine = layers.find((l) => l.id === "streets-line");
    expect(cellsFill).toBeDefined();
    expect(cellsOutline).toBeDefined();
    expect(streetsLine).toBeDefined();

    // cells-fill/cells-outline: top-level interpolate on zoom, fading in
    // between z12 and z14 (VISUAL.md: "hex cells fade in ~z12-15").
    const fillOpacity = (cellsFill as { paint: { "fill-opacity": unknown[] } }).paint["fill-opacity"];
    expect(fillOpacity[0]).toBe("interpolate");
    expect((fillOpacity[2] as unknown[])[0]).toBe("zoom");
    expect(fillOpacity[3]).toBe(12);
    expect(fillOpacity[5]).toBe(14);

    // cells-outline: subject cell opacity is 1 at both zoom stops (always
    // visible, VISUAL.md: "Subject cell always visible").
    const outlineOpacity = (cellsOutline as { paint: { "line-opacity": unknown[] } }).paint["line-opacity"];
    const subjectAtMinZoom = outlineOpacity[4] as unknown[];
    const subjectAtMaxZoom = outlineOpacity[6] as unknown[];
    expect(subjectAtMinZoom[2]).toBe(1); // case output when isSubject == 1, at zoom 12
    expect(subjectAtMaxZoom[2]).toBe(1); // case output when isSubject == 1, at zoom 14

    // streets-line: top-level interpolate on zoom for both line-width and
    // line-opacity (the two props that were broken).
    const streetsPaint = (streetsLine as { paint: { "line-width": unknown[]; "line-opacity": unknown[] } }).paint;
    expect(streetsPaint["line-width"][0]).toBe("interpolate");
    expect((streetsPaint["line-width"][2] as unknown[])[0]).toBe("zoom");
    expect(streetsPaint["line-opacity"][0]).toBe("interpolate");
    expect((streetsPaint["line-opacity"][2] as unknown[])[0]).toBe("zoom");
  });
});
