import type { StyleSpecification } from "maplibre-gl";
// @maplibre/maplibre-gl-style-spec is already a real transitive dependency
// of maplibre-gl (see maplibre-gl's own package.json + web/package-lock.json)
// and is what `map.addLayer()` calls internally to validate a layer before
// adding it to the map -- this import runs that exact same validator here,
// with no WebGL/browser required, so a regression like the one below fails
// a `vitest run` instead of shipping silently to prod again.
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import {
  buildCitywideGridLayers,
  buildDestinationPreviewLayers,
  buildMapStyle,
  buildOverlayLayers,
  buildReachLayers,
  buildTileHighlightLayers,
} from "./mapStyle";

// FIXED 2026-07-15: streets-line's line-width/line-opacity nested a
// `["zoom"]` expression inside `*`/`case` instead of using it as the direct
// input to a top-level `interpolate`/`step`. MapLibre GL JS's style
// validator rejects that -- but `map.addLayer()` swallows the rejection: it
// logs a `console.error` and simply never adds the layer, no thrown
// exception. That's why this shipped and passed every API/console-exception
// check while the zoom LOD was silently dead on prod.
// See `Claude/agent-reports/2026-07-15-bearings-live-map-smoke.md` (vault)
// for the live-browser repro that caught it.
//
// RETIRED 2026-07-29 (SPEC-lens-report.md): the local metric-shaded hex
// disk (cells-fill/cells-outline) and the visible citywide grid outline
// (citywide-cells-outline) no longer exist -- see mapStyle.ts's own
// updated comment. This file's coverage of those two is replaced below
// with equivalent real-validator + "no illegal nested zoom expression"
// coverage for what replaced them (reach-rings/reach-dots).

describe("buildMapStyle (basemap)", () => {
  it("validates with zero errors against MapLibre's real style validator", () => {
    const style = buildMapStyle("https://example.com/tiles/nyc-basemap.pmtiles");
    expect(validateStyleMin(style)).toEqual([]);
  });

  // LAYOUT-V3 WAVE 1d item 12 (2026-08-03): the New Jersey dim mask -- a
  // real closed-ring polygon baked directly into the style (no fetch), not
  // a fifth colour (BONE at reduced opacity, same token every other "no
  // colour outside the four" layer in this file uses).
  it("includes the nj-mask-fill layer with a real, closed-ring polygon source", () => {
    const style = buildMapStyle("https://example.com/tiles/nyc-basemap.pmtiles");
    const layer = style.layers.find((l) => l.id === "nj-mask-fill") as
      | { source: string; paint: { "fill-color": string } }
      | undefined;
    expect(layer).toBeDefined();
    expect(layer?.paint["fill-color"]).toBe("#EDE9DE");

    const source = style.sources["nj-mask"] as {
      type: string;
      data: { geometry: { type: string; coordinates: [number, number][][] } };
    };
    expect(source.type).toBe("geojson");
    const ring = source.data.geometry.coordinates[0];
    expect(ring.length).toBeGreaterThan(3);
    // A real closed ring -- first and last point identical.
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // Every point falls inside (or on the edge of) NYC_BBOX -- this mask
    // must never extend beyond the basemap's own baked extract.
    for (const [lng, lat] of ring) {
      expect(lng).toBeGreaterThanOrEqual(-74.3);
      expect(lng).toBeLessThanOrEqual(-73.7);
      expect(lat).toBeGreaterThanOrEqual(40.47);
      expect(lat).toBeLessThanOrEqual(40.93);
    }
  });

  it("paints nj-mask-fill after (on top of) the base earth/water/roads layers", () => {
    const style = buildMapStyle("https://example.com/tiles/nyc-basemap.pmtiles");
    const ids = style.layers.map((l) => l.id);
    const maskIdx = ids.indexOf("nj-mask-fill");
    expect(maskIdx).toBeGreaterThan(ids.indexOf("earth"));
    expect(maskIdx).toBeGreaterThan(ids.indexOf("water"));
    expect(maskIdx).toBeGreaterThan(ids.indexOf("roads-major"));
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

  it("no longer includes the retired hex-disk or precinct-choropleth layers", () => {
    const ids = buildOverlayLayers().map((l) => l.id);
    expect(ids).not.toContain("cells-fill");
    expect(ids).not.toContain("cells-outline");
    expect(ids).not.toContain("precinct-fill");
    expect(ids).not.toContain("precinct-outline");
    expect(ids).not.toContain("citywide-cells-outline");
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

  it("still expresses the intended zoom LOD for building mass and streets", () => {
    const layers = buildOverlayLayers();
    const buildingsFill = layers.find((l) => l.id === "buildings-fill");
    const streetsLine = layers.find((l) => l.id === "streets-line");
    expect(buildingsFill).toBeDefined();
    expect(streetsLine).toBeDefined();

    const streetsPaint = (streetsLine as { paint: { "line-width": unknown[]; "line-opacity": unknown[] } }).paint;
    expect(streetsPaint["line-width"][0]).toBe("interpolate");
    expect((streetsPaint["line-width"][2] as unknown[])[0]).toBe("zoom");
    expect(streetsPaint["line-opacity"][0]).toBe("interpolate");
    expect((streetsPaint["line-opacity"][2] as unknown[])[0]).toBe("zoom");
  });

  // SPEC-precompute-v2.md Phase 2 / VISUAL.md §5 REVISED 2026-07-15: "click
  // any real block to load its report" must keep working, invisibly (the
  // visible grid outline is what's retired, not the hit-test). This
  // exercises the exact layer MapView.tsx actually adds to the map.
  it("includes the citywide grid's hit-test fill, and ONLY the fill (the visible outline is retired)", () => {
    const layers = buildOverlayLayers();
    const fill = layers.find((l) => l.id === "citywide-cells-fill");
    expect(fill).toBeDefined();
    expect((fill as { source: string }).source).toBe("citywide-cells");
    expect(layers.find((l) => l.id === "citywide-cells-outline")).toBeUndefined();
  });

  // LAYOUT-V3 WAVE 1c (2026-08-03): the hit-test fill is no longer a bare
  // `0` -- it's a feature-state-driven `case` expression (Noah's item 3:
  // "a visible hover state on the block under the cursor"), transparent AT
  // REST and only visible for whichever one feature MapView.tsx's own
  // mousemove handler has marked `hover: true`. This asserts the REST
  // (false) branch is still 0 -- "genuinely transparent" now means "when
  // nothing is hovered," not "always," which is the whole point of item 3.
  it("the citywide grid's fill is transparent at rest, hit-testing (and now hover) only, never a permanent visible wash", () => {
    const fill = buildOverlayLayers().find((l) => l.id === "citywide-cells-fill") as {
      paint: { "fill-opacity": unknown[] };
    };
    const expr = fill.paint["fill-opacity"];
    expect(expr[0]).toBe("case");
    expect(expr[expr.length - 1]).toBe(0); // the "no feature-state hover" fallback branch
  });

  it("the citywide grid's hover fill reads a real feature-state boolean, not a fabricated always-on wash", () => {
    const fill = buildOverlayLayers().find((l) => l.id === "citywide-cells-fill") as {
      paint: { "fill-opacity": unknown[] };
    };
    const expr = fill.paint["fill-opacity"];
    const condition = expr[1] as unknown[];
    expect(condition[0]).toBe("boolean");
    expect(condition[1]).toEqual(["feature-state", "hover"]);
  });

  it("buildCitywideGridLayers() returns exactly the one hit-test layer, sourced from citywide-cells", () => {
    const layers = buildCitywideGridLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBe("citywide-cells-fill");
  });
});

describe("buildReachLayers (5/10/15-minute walk rings + amenity/station dots)", () => {
  function styleWithReachLayers(): StyleSpecification {
    return {
      version: 8,
      sources: {
        "reach-rings": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        "reach-dots": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: buildReachLayers(),
    };
  }

  it("validates with zero errors against MapLibre's real style validator", () => {
    expect(validateStyleMin(styleWithReachLayers())).toEqual([]);
  });

  it("includes a fill + outline pair for the rings, and a circle layer for the dots", () => {
    const ids = buildReachLayers().map((l) => l.id);
    expect(ids).toEqual(["reach-rings-fill", "reach-rings-outline", "reach-dots"]);
  });

  it("the ring bands get progressively fainter from the innermost (5 min) to the outermost (15 min)", () => {
    // Matches SPEC-lens-report.md §3's "nested" read: the 5-minute band is
    // the most opaque (visually "closest"/darkest), 15 is the faintest.
    const fill = buildReachLayers().find((l) => l.id === "reach-rings-fill") as {
      paint: { "fill-opacity": unknown[] };
    };
    const expr = fill.paint["fill-opacity"];
    expect(expr[0]).toBe("match");
    const opacityFor = (minutes: number) => {
      const idx = expr.findIndex((v) => v === minutes);
      return expr[idx + 1] as number;
    };
    expect(opacityFor(5)).toBeGreaterThan(opacityFor(10));
    expect(opacityFor(10)).toBeGreaterThan(opacityFor(15));
  });

  it("dots are a single uniform ink colour, never a per-category hue (VISUAL.md: no colour outside the four tokens)", () => {
    const dots = buildReachLayers().find((l) => l.id === "reach-dots") as {
      paint: { "circle-color": unknown };
    };
    expect(typeof dots.paint["circle-color"]).toBe("string");
  });
});

// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 4):
// what a hovered/expanded side-panel tile emphasizes on the map.
describe("buildTileHighlightLayers (side-panel tile <-> map emphasis, item 4)", () => {
  function styleWithTileHighlightLayers(): StyleSpecification {
    return {
      version: 8,
      sources: {
        "tile-highlight-region": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        "tile-highlight-points": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: buildTileHighlightLayers(),
    };
  }

  it("validates with zero errors against MapLibre's real style validator", () => {
    expect(validateStyleMin(styleWithTileHighlightLayers())).toEqual([]);
  });

  it("includes a fill + outline pair for the region, and a circle layer for the points", () => {
    const ids = buildTileHighlightLayers().map((l) => l.id);
    expect(ids).toEqual(["tile-highlight-fill", "tile-highlight-outline", "tile-highlight-points"]);
  });

  it("is included in buildOverlayLayers(), painted after the reach layers", () => {
    const ids = buildOverlayLayers().map((l) => l.id);
    const reachIdx = ids.indexOf("reach-dots");
    const highlightIdx = ids.indexOf("tile-highlight-fill");
    expect(reachIdx).toBeGreaterThanOrEqual(0);
    expect(highlightIdx).toBeGreaterThan(reachIdx);
  });
});

// LAYOUT-V3 WAVE 3 (2026-08-03, SPEC-layout-v3.md §5.3): the getting-around
// region's zone preview -- the same reach-ring visual technique, redrawn
// around whichever destination bar is hovered/selected, on its OWN
// source/layer set (never overwrites the searched-address's own
// reach-rings).
describe("buildDestinationPreviewLayers (getting-around zone preview, §5.3)", () => {
  function styleWithDestinationPreviewLayers(): StyleSpecification {
    return {
      version: 8,
      sources: {
        "destination-rings": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        "destination-point": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: buildDestinationPreviewLayers(),
    };
  }

  it("validates with zero errors against MapLibre's real style validator", () => {
    expect(validateStyleMin(styleWithDestinationPreviewLayers())).toEqual([]);
  });

  it("includes a fill + outline pair for the rings, and a circle layer for the destination point", () => {
    const ids = buildDestinationPreviewLayers().map((l) => l.id);
    expect(ids).toEqual(["destination-rings-fill", "destination-rings-outline", "destination-point"]);
  });

  it("uses its own source, never the searched-address's reach-rings source", () => {
    for (const layer of buildDestinationPreviewLayers()) {
      const source = (layer as { source?: string }).source;
      expect(source).not.toBe("reach-rings");
      expect(source).not.toBe("reach-dots");
    }
  });

  it("is included in buildOverlayLayers(), painted last (topmost)", () => {
    const ids = buildOverlayLayers().map((l) => l.id);
    expect(ids[ids.length - 1]).toBe("destination-point");
    expect(ids.indexOf("destination-rings-fill")).toBeGreaterThan(ids.indexOf("tile-highlight-points"));
  });
});
