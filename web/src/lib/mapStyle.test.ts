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

  // LAYOUT-V3 WAVE 1f item 1 (2026-08-11): re-specified from "mask paints
  // over water too" to "mask paints over roads/earth, but the real water
  // shape always repaints on top of the mask" -- Noah's "the river stays
  // unfaded" requirement. mask no longer needs to out-rank "water" itself
  // (it doesn't -- see the new water-unmasked assertion below), only the
  // earth/open-space/road layers it's actually meant to hide.
  it("paints nj-mask-fill after (on top of) earth/open-space/roads, but a real water layer repaints on top of the mask", () => {
    const style = buildMapStyle("https://example.com/tiles/nyc-basemap.pmtiles");
    const ids = style.layers.map((l) => l.id);
    const maskIdx = ids.indexOf("nj-mask-fill");
    expect(maskIdx).toBeGreaterThan(ids.indexOf("earth"));
    expect(maskIdx).toBeGreaterThan(ids.indexOf("open-space"));
    expect(maskIdx).toBeGreaterThan(ids.indexOf("roads-minor"));
    expect(maskIdx).toBeGreaterThan(ids.indexOf("roads-major"));

    // The river-preserving fix itself: a second real "water" source-layer
    // fill, painted strictly after nj-mask-fill, with the exact same
    // fill-color/fill-opacity as the base "water" layer -- so wherever the
    // mask's hand-plotted polygon happens to overlap real water, the actual
    // vector water shape wins the last paint and reads unfaded.
    const waterUnmasked = style.layers.find((l) => l.id === "water-unmasked") as
      | { source: string; "source-layer"?: string; paint: { "fill-color": string; "fill-opacity": number } }
      | undefined;
    const baseWater = style.layers.find((l) => l.id === "water") as
      | { paint: { "fill-color": string; "fill-opacity": number } }
      | undefined;
    expect(waterUnmasked).toBeDefined();
    expect(waterUnmasked?.source).toBe("basemap");
    expect(waterUnmasked?.["source-layer"]).toBe("water");
    expect(waterUnmasked?.paint["fill-color"]).toBe(baseWater?.paint["fill-color"]);
    expect(waterUnmasked?.paint["fill-opacity"]).toBe(baseWater?.paint["fill-opacity"]);
    expect(ids.indexOf("water-unmasked")).toBeGreaterThan(maskIdx);
  });

  // LAYOUT-V3 WAVE 1f item 1: the load-bearing regression this wave fixes --
  // real published shoreline longitudes (not guessed) confirm the PRE-1f
  // polygon crossed onto actual Manhattan/Bronx land at several latitudes
  // (see mapStyle.ts's own NJ_MASK_POLYGON comment for the exact
  // measurements). Every east-edge vertex must now sit measurably WEST of
  // the real Manhattan/Bronx shore at its own latitude -- a hard numeric
  // guard so this regression can't silently reappear on a future edit.
  it("never crosses onto real Manhattan/Bronx land -- every east-edge vertex sits west of the real shore at its own latitude", () => {
    const style = buildMapStyle("https://example.com/tiles/nyc-basemap.pmtiles");
    const source = style.sources["nj-mask"] as {
      type: string;
      data: { geometry: { type: string; coordinates: [number, number][][] } };
    };
    const ring = source.data.geometry.coordinates[0];
    // Real, published west-shore longitudes for Manhattan/the Bronx at
    // representative latitudes along the Hudson (Battery Park, Chelsea
    // Piers, Midtown/Javits, Riverside Park/UWS, Washington Heights/GWB,
    // Inwood/Riverdale) -- every mask vertex at a nearby latitude must stay
    // west (more negative) than these, with real margin, never approaching
    // or crossing them.
    const REAL_SHORE_BY_LAT: [number, number][] = [
      [40.71, -74.019], // Battery Park / Tribeca
      [40.75, -74.005], // Chelsea / Midtown west side
      [40.8, -73.98], // Riverside Park / Upper West Side
      [40.85, -73.94], // Washington Heights / GW Bridge (Manhattan side)
      [40.87, -73.925], // Inwood / Riverdale transition
    ];
    for (const [lat, realShoreLng] of REAL_SHORE_BY_LAT) {
      const nearest = ring.reduce((best, pt) =>
        Math.abs(pt[1] - lat) < Math.abs(best[1] - lat) ? pt : best,
      );
      expect(nearest[0]).toBeLessThan(realShoreLng);
    }
  });

  // WAVE 6f item 9 (2026-08-11, Noah: "hard-edged dark gray diagonal band
  // sweeping Greenpoint -> Newtown Creek -> LIC"). The band itself turned
  // out to be a real, malformed polygon in third-party Protomaps tile data
  // (see NEWTOWN_CREEK_BAD_ZONE's own comment in mapStyle.ts for the full
  // live diagnosis) -- this codebase controls none of THOSE vertices, so
  // it can't be unit-tested here. What this codebase DOES control is every
  // hand-plotted polygon it authors itself (NJ_MASK_POLYGON,
  // NEWTOWN_CREEK_BAD_ZONE, and any future one) -- a self-intersecting/
  // bowtie ring in ONE of those would earcut-mistriangulate into exactly
  // this same class of stray-geometry bug, just from a bug THIS repo
  // introduced instead of a third party. This generic, ring-agnostic
  // validity check runs against EVERY geojson Polygon source baked into
  // buildMapStyle()'s own output (not a hardcoded list of two names), so a
  // future mask polygon is covered automatically the moment it's added
  // here, with no second place to remember to update.
  function isClosedSimplePolygon(ring: [number, number][]): { closed: boolean; simple: boolean } {
    const closed = ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
    // Real edges only -- the ring's own last point duplicates the first
    // (the "closed" check above), so edges run [0,1), not through the
    // duplicate.
    const n = ring.length - 1;
    const edges: [[number, number], [number, number]][] = [];
    for (let i = 0; i < n; i++) edges.push([ring[i], ring[(i + 1) % n]]);

    function ccw(a: [number, number], b: [number, number], c: [number, number]): boolean {
      return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
    }
    function segmentsIntersect(
      a: [number, number],
      b: [number, number],
      c: [number, number],
      d: [number, number],
    ): boolean {
      return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
    }

    let simple = true;
    for (let i = 0; i < edges.length && simple; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        // Adjacent edges (including the wrap-around pair) legitimately
        // share an endpoint -- not a self-intersection, skip.
        if (j === i + 1 || (i === 0 && j === edges.length - 1)) continue;
        if (segmentsIntersect(edges[i][0], edges[i][1], edges[j][0], edges[j][1])) {
          simple = false;
          break;
        }
      }
    }
    return { closed, simple };
  }

  it("every hand-plotted mask polygon baked into the style is a real closed, non-self-intersecting ring", () => {
    const style = buildMapStyle("https://example.com/tiles/nyc-basemap.pmtiles");
    let checked = 0;
    for (const [sourceId, source] of Object.entries(style.sources)) {
      if (source.type !== "geojson") continue;
      const data = (source as { data: unknown }).data as {
        type: string;
        geometry?: { type: string; coordinates?: unknown };
      };
      if (data.type !== "Feature" || data.geometry?.type !== "Polygon") continue;
      const ring = (data.geometry.coordinates as [number, number][][])[0];
      const { closed, simple } = isClosedSimplePolygon(ring);
      expect(closed, `${sourceId}'s polygon ring is not closed (first point != last point)`).toBe(true);
      expect(simple, `${sourceId}'s polygon ring is self-intersecting (a bowtie) -- this is exactly the earcut-mistriangulation bug class WAVE 6f item 9 diagnosed in third-party tile data; this repo's OWN masks must never ship one`).toBe(true);
      checked++;
    }
    // A real regression guard, not a vacuous pass: this must find at least
    // the two masks this file bakes today (nj-mask, newtown-creek-mask) --
    // if a future refactor moved mask polygons to a shape this test can't
    // see (e.g. a different source type), this count catches that too.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  // WAVE 6f item 9 -- the mitigation's own layering contract: the cancel
  // fill is fully opaque and sits above roads-minor/roads-major (painted
  // near the top of this style), so without a repaint, real streets inside
  // NEWTOWN_CREEK_BAD_ZONE would vanish -- a worse regression than the bug
  // this wave fixes. This is the direct regression guard for that.
  it("repaints roads-minor/roads-major after the Newtown Creek cancel fill, and repaints the creek's real line last", () => {
    const style = buildMapStyle("https://example.com/tiles/nyc-basemap.pmtiles");
    const ids = style.layers.map((l) => l.id);
    const cancelIdx = ids.indexOf("newtown-creek-mask-fill");
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(ids.indexOf("roads-minor-repaint")).toBeGreaterThan(cancelIdx);
    expect(ids.indexOf("roads-major-repaint")).toBeGreaterThan(cancelIdx);
    expect(ids.indexOf("newtown-creek-line")).toBeGreaterThan(ids.indexOf("roads-minor-repaint"));
    expect(ids.indexOf("newtown-creek-line")).toBeGreaterThan(ids.indexOf("roads-major-repaint"));

    // The repaints must be REAL copies (same filter/paint), not stubs --
    // regression guard against someone "fixing" a duplicate-id lint error
    // by hollowing one out instead of keeping both in sync.
    const original = style.layers.find((l) => l.id === "roads-minor") as { filter: unknown; paint: unknown };
    const repaint = style.layers.find((l) => l.id === "roads-minor-repaint") as { filter: unknown; paint: unknown };
    expect(repaint.filter).toEqual(original.filter);
    expect(repaint.paint).toEqual(original.paint);
  });

  // The honest fallback itself: a real river/stream/strait LineString from
  // the SAME "water" source-layer the buggy polygon fill comes from --
  // never a hand-plotted guess at the creek's real path.
  it("newtown-creek-line reads real river/stream/strait LineStrings from the basemap's own water source-layer", () => {
    const style = buildMapStyle("https://example.com/tiles/nyc-basemap.pmtiles");
    const line = style.layers.find((l) => l.id === "newtown-creek-line") as {
      type: string;
      source: string;
      "source-layer"?: string;
      filter: unknown[];
    };
    expect(line.type).toBe("line");
    expect(line.source).toBe("basemap");
    expect(line["source-layer"]).toBe("water");
    expect(line.filter).toEqual(["in", ["get", "kind"], ["literal", ["river", "stream", "strait"]]]);
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

  // WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): the route-line preview
  // -- must read visually distinct from the always-on "subway-line"
  // backdrop it's drawn over (VISUAL.md's four-colour rule: distinct by
  // width/opacity, never a new colour).
  it("route-line-highlight is sourced from route-line and reads visually distinct from the backdrop subway-line", () => {
    const layers = buildOverlayLayers();
    const highlight = layers.find((l) => l.id === "route-line-highlight") as {
      source: string;
      paint: { "line-width": number; "line-opacity": number; "line-color": string };
    };
    const backdrop = layers.find((l) => l.id === "subway-line") as {
      paint: { "line-width": number; "line-opacity": number; "line-color": string };
    };
    expect(highlight).toBeDefined();
    expect(highlight.source).toBe("route-line");
    expect(highlight.paint["line-width"]).toBeGreaterThan(backdrop.paint["line-width"]);
    expect(highlight.paint["line-color"]).toBe(backdrop.paint["line-color"]); // no new colour
  });
});

// LAYOUT-V3 WAVE 6c item 6 (2026-08-11, Noah: "the 5/10/15-minute walk
// rings around searched addresses aren't helpful either") -- the
// "reach-rings-fill"/"reach-rings-outline" layers this describe block used
// to also cover are deleted (see buildReachLayers()'s own comment); only
// the amenity/station dots survive. Tests for the removed ring layers are
// deleted along with them, not left disabled -- a real coverage reduction
// matching a real feature removal, not a gap.
describe("buildReachLayers (amenity/station dots for a searched address)", () => {
  function styleWithReachLayers(): StyleSpecification {
    return {
      version: 8,
      sources: {
        "reach-dots": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: buildReachLayers(),
    };
  }

  it("validates with zero errors against MapLibre's real style validator", () => {
    expect(validateStyleMin(styleWithReachLayers())).toEqual([]);
  });

  it("includes exactly one circle layer for the dots, no ring layers", () => {
    const ids = buildReachLayers().map((l) => l.id);
    expect(ids).toEqual(["reach-dots"]);
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
// region's zone preview -- straight-line 5/10/15-minute rings redrawn
// around whichever destination bar is hovered/selected, on its own
// source/layer set, fully independent of the (now-removed, Wave 6c item 6)
// searched-address rings.
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

  it("uses its own source, never the searched-address's own reach source(s)", () => {
    // "reach-rings" no longer exists as a real source (Wave 6c item 6
    // deleted it) -- kept in this list anyway as a regression guard against
    // ever reintroducing a same-named collision, alongside the one
    // searched-address reach source that does still exist.
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
