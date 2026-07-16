import type { StyleSpecification } from "maplibre-gl";
// @maplibre/maplibre-gl-style-spec is already a real transitive dependency
// of maplibre-gl (see maplibre-gl's own package.json + web/package-lock.json)
// and is what `map.addLayer()` calls internally to validate a layer before
// adding it to the map -- this import runs that exact same validator here,
// with no WebGL/browser required, so a regression like the one below fails
// a `vitest run` instead of shipping silently to prod again.
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { buildCitywideGridLayers, buildMapStyle, buildOverlayLayers } from "./mapStyle";

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

  // SPEC-precompute-v2.md Phase 2 / VISUAL.md §5 REVISED 2026-07-15: "The
  // hex grid COVERS THE WHOLE CITY... present across the entire map at
  // every zoom so any cell is clickable". buildOverlayLayers() spreads
  // buildCitywideGridLayers() in, so these assertions exercise the exact
  // layers MapView.tsx actually adds to the map, not a separate copy.
  it("includes the citywide grid's fill (hit-test) and outline layers, both reading the citywide-cells source", () => {
    const layers = buildOverlayLayers();
    const fill = layers.find((l) => l.id === "citywide-cells-fill");
    const outline = layers.find((l) => l.id === "citywide-cells-outline");
    expect(fill).toBeDefined();
    expect(outline).toBeDefined();
    expect((fill as { source: string }).source).toBe("citywide-cells");
    expect((outline as { source: string }).source).toBe("citywide-cells");
  });

  it("the citywide grid's fill is genuinely transparent (VISUAL.md: 'transparent fill for hit-testing'), never a visible wash", () => {
    const fill = buildOverlayLayers().find((l) => l.id === "citywide-cells-fill") as {
      paint: { "fill-opacity": unknown };
    };
    expect(fill.paint["fill-opacity"]).toBe(0);
  });

  it("the citywide grid's outline is present (non-zero opacity) at zoom 9 (city scale), not gated behind a minzoom cut", () => {
    // Unlike the local per-address "cells" layer (which fades in only
    // 12->14, VISUAL.md: only near a searched address), the citywide grid
    // must already be visible at city-wide zoom -- this is the literal
    // "covers the whole city" requirement, checked as real interpolate
    // output, not just "the layer exists".
    const outline = buildOverlayLayers().find((l) => l.id === "citywide-cells-outline") as {
      paint: { "line-opacity": unknown[] };
    };
    const opacity = outline.paint["line-opacity"];
    expect(opacity[0]).toBe("interpolate");
    expect((opacity[2] as unknown[])[0]).toBe("zoom");
    expect(opacity[3]).toBe(9); // first zoom stop is city scale, not a higher minzoom
    const notSelectedAtCityZoom = (opacity[4] as unknown[])[2];
    expect(notSelectedAtCityZoom).toBeGreaterThan(0);
  });

  it("a selected cell's outline is emphasized (full opacity, red) at every zoom, via feature-state, not a property rebuild", () => {
    const layers = buildCitywideGridLayers();
    const outline = layers.find((l) => l.id === "citywide-cells-outline") as {
      paint: { "line-color": unknown[]; "line-opacity": unknown[] };
    };
    const color = outline.paint["line-color"];
    expect(color[0]).toBe("case");
    expect(JSON.stringify(color[1])).toContain("feature-state");
    const opacity = outline.paint["line-opacity"];
    const selectedAtMinZoom = (opacity[4] as unknown[])[2];
    const selectedAtMaxZoom = (opacity[6] as unknown[])[2];
    expect(selectedAtMinZoom).toBe(1);
    expect(selectedAtMaxZoom).toBe(1);
  });

  it("every citywide grid paint expression uses ['zoom'] only as the direct input to a top-level interpolate/step (same regression class as the 2026-07-15 fix above)", () => {
    for (const layer of buildCitywideGridLayers()) {
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
});
