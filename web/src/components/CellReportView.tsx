import { useEffect, useState } from "react";
import { crimeRelativeLabel, formatPercentile } from "../lib/crime";
import { unreachableReasonSentence, unreachableReasonShortLabel } from "../lib/transit";
import type { CellProfile, UnreachableReason } from "../types";
import { SourceTag } from "./SourceTag";
import { Stamp } from "./Stamp";
import { Stat } from "./Stat";

// A BLOCK-level report, rendered from GET /api/cell/{h3} (SPEC-precompute-
// v2.md Phase 2) -- deliberately its OWN component, not ReportView's cards
// reused with an adapter. Every existing card (TransitCard, AmenitiesCard,
// QuietCard, GreenCard, BuildingCard) was written for /api/profile's
// BUILDING-level shape, and several of its captions state a specific
// methodology that genuinely differs at cell resolution:
//   - AmenitiesCard says "counted in this block and the blocks right
//     around it" -- true for /api/profile (bearings/profile.py's
//     _amenities() sums a k=1 seven-cell ring), false for a precomputed
//     cell profile (bearings/cellprofile.py counts ONE cell only, no ring).
//   - QuietCard/GreenCard say "within a 5-minute walk (400m radius)" -- a
//     circle around one address point; a cell profile is one real H3
//     hexagon (0.105 km²), a different shape and (usually) a different
//     area.
//   - TransitCard expects a NAMED list of nearest stations
//     (`nearest_stations: Station[]`); the block precompute only has a
//     COUNT (`stations_within_500m`) -- rendering an empty station list
//     through that card would print "No subway station within a 20-minute
//     walk" even when several real stations are nearby, exactly the kind
//     of confidently-wrong number this project's own rules forbid.
//   - BuildingCard expects per-building HPD violations broken into class
//     A/B/C; the block precompute only has the AGGREGATED open Class C
//     count across every lot in the cell (cellprofile.py's own module
//     docstring: "the number that matters", deliberately not the finer
//     breakdown at cell resolution).
// Reusing the building-level cards with invented/zeroed fields to paper
// over these gaps would fabricate a precision the data doesn't have. This
// component instead states each number's real, honest scope in its own
// copy, while reusing every real shared primitive (Stat, SourceTag, Stamp,
// the crime-percentile framing, and the exact `.field`/`.fields` CSS
// classes) so the visual chrome matches the building-level report exactly.
//
// LAYOUT-V3 WAVE 1 (2026-08-02, SPEC-layout-v3.md): this file used to
// export ONE component rendering all six fields as a single grid. App.tsx
// now needs to place them in two different places on the page -- "Getting
// around" (transit) below the map, full width; the other five beside the
// map in a narrow side panel -- so this file exports TWO components
// instead. This is a pure structural split: every field's JSX/copy below
// is byte-identical to the pre-split version, just moved into whichever of
// the two functions now owns it. Confirmed via SPEC-layout-v3.md §2 that
// the component this wave replaces beside the map is MapView.tsx's old
// `readout` panel (the "What's here" hover-legend box), NOT this component
// -- CellReportView's own five non-transit fields are what now FILLS that
// space, they are not what got removed from it.
const CATEGORY_LABELS: [keyof CellProfile["amenities"]["counts"], string][] = [
  ["grocery", "Grocery"],
  ["cafe", "Cafe"],
  ["restaurant", "Restaurant"],
  ["bar", "Bar"],
  ["pharmacy", "Pharmacy"],
  ["gym", "Gym"],
  ["park", "Park"],
  ["laundry", "Laundry"],
];

const ANCHOR_LABELS: Record<keyof CellProfile["transit"]["to_anchors"], string> = {
  midtown: "Midtown",
  wtc: "World Trade Center",
  downtown_brooklyn: "Downtown Brooklyn",
  newport_path: "Newport, NJ (PATH)",
};

const ERA_LABELS: Record<"prewar" | "postwar" | "modern", string> = {
  prewar: "Pre-war",
  postwar: "Post-war",
  modern: "Modern",
};

// Same generous bar-scale ceiling TransitCard uses, for the same reason
// (see that component's own comment) -- kept as a separate constant rather
// than importing TransitCard's private one so the two components stay
// independently editable.
const BAR_SCALE_MAX_MIN = 60;

// "Getting around" -- the one transit field, rendered below the map, full
// width (SPEC-layout-v3.md §3/§5: moved out of the side panel deliberately,
// since it's about to grow editable destination rows in a later wave that
// need real width, not a narrow column).
export function GettingAroundField({ cell }: { cell: CellProfile }) {
  const anchorEntries = Object.entries(cell.transit.to_anchors) as [
    keyof CellProfile["transit"]["to_anchors"],
    number,
  ][];

  // Every anchor that failed carries its own real reason (see
  // web/src/types.ts's UnreachableReasons) -- collapse to the DISTINCT
  // reasons actually present so a shared cause (today, every failing cell
  // fails all four anchors for the same reason -- see the 2026-07-18
  // no-route-copy-split report) only prints one explanation, not four
  // identical ones. Still correct if that ever stops being true: a future
  // cell with a genuine per-anchor split would print one sentence per
  // distinct reason, not silently drop one.
  const distinctUnreachableReasons = Array.from(
    new Set(
      anchorEntries
        .map(([key]) => cell.transit.unreachable_reason[key])
        .filter((reason): reason is UnreachableReason => reason !== null)
    )
  );

  return (
    <div className="fields">
      <article className="field field--wide" aria-labelledby="cell-transit-heading">
        <header className="field__head">
          <div>
            <h2 className="field__title" id="cell-transit-heading">
              Getting around
            </h2>
          </div>
          {/* Every other card's stamp answers "does this card have real
              content" (crime: !crime -> no_data; building age: !hasBuildingAge
              -> no_data). Transit's cell block ALWAYS has real content --
              cellprofile.py's _transit_by_cell() fills all 4 anchors with
              either a real ride time or a real, honest unreachable_reason,
              never nothing -- so it's hardcoded confirmed to match, same as
              amenities/noise/trees below. */}
          <Stamp variant="confirmed" compact />
        </header>

        <div className="anchors">
          <p className="anchors__label">Ride time to —</p>
          {anchorEntries.map(([key, minutes]) => {
            const reachable = minutes >= 0;
            const pct = reachable ? Math.min(100, (minutes / BAR_SCALE_MAX_MIN) * 100) : 0;
            const reason = cell.transit.unreachable_reason[key];
            return (
              <div className="anchor" key={key}>
                <span className="anchor__label">{ANCHOR_LABELS[key]}</span>
                <span className="anchor__track">
                  {reachable ? <span className="anchor__fill" style={{ width: `${pct}%` }} /> : null}
                </span>
                <span className={`anchor__value${reachable ? "" : " anchor__value--nodata"}`}>
                  {reachable ? `${minutes} min` : unreachableReasonShortLabel(reason as UnreachableReason)}
                </span>
              </div>
            );
          })}
        </div>

        {distinctUnreachableReasons.length > 0 && (
          <p className="field__caveat mono">
            <span className="field__caveat-kicker" aria-hidden="true">
              why
            </span>
            {distinctUnreachableReasons.map(unreachableReasonSentence).join(" ")}
          </p>
        )}

        <p className="field__provenance">
          Real MTA/PATH schedules · weekday 8am departure · fastest route to four key
          destinations in the city.
          <br />
          <SourceTag source={cell.transit.source} />
        </p>
      </article>
    </div>
  );
}

// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 4): which
// map subject each tile's disclosure "talks about" -- MapView.tsx reads this
// same key to decide what to emphasize. Deliberately just the five tile
// identities, not a richer shape: the map-side effect that consumes this
// still has to independently decide WHETHER real client-side geometry exists
// for a given key (see MapView.tsx's own "tile highlight" effect comment for
// the amenities-tile gap this can't paper over from here).
export type TileHighlightKey = "amenities" | "crime" | "noise" | "trees" | "building";

// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 5): the
// human-readable title for whichever tile's disclosure is currently showing
// in the shared detail region below the grid -- see that region's own
// comment for why a shared region replaced Wave 1b's per-tile <details>.
const TILE_TITLES: Record<TileHighlightKey, string> = {
  amenities: "Grocery & everyday places",
  crime: "Crime near here",
  noise: "Noise complaints",
  trees: "Living street trees",
  building: "Building age & serious hazards",
};

// The five non-transit fields -- grocery/amenities, crime, noise, trees,
// building age + hazards -- rendered beside the map in the side panel
// (SPEC-layout-v3.md §3/§4).
//
// LAYOUT-V3 WAVE 1b (2026-08-02, SPEC-layout-v3.md §8 Wave 1b -- corrective
// after Noah rejected Wave 1's shipped result: "the width spread i
// requested didn't happen we just shifted the big cards in a long vertical
// column next to the map"). Wave 1's five `.field` cards (full provenance
// paragraphs inline, always visible) are exactly the "long vertical column"
// failure mode the amended spec now names and bans. This function now
// renders five DENSE `.tile`s instead: a plain-language label, one
// headline value/verdict, the existing stamp, and a disclosure affordance
// -- everything that isn't the headline value (every consequence sentence,
// caveat, provenance paragraph, and source citation this file rendered
// before) moves verbatim into that disclosure, per the spec's explicit
// "zero strings deleted" rule.
//
// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 5,
// Noah: "the native <details> expansion currently stretches both tiles in
// a grid row -- narrow, skinny, unintuitive"). Root cause: `.tilegrid` is a
// 2-column CSS grid with default `align-items: stretch`, so when one
// tile's own <details> grew tall (opening inline, inside a ~175px-wide
// grid cell), the ROW's height grew to match, and CSS stretched its ROW
// NEIGHBOUR to the same height too -- exactly Noah's "stretches both
// tiles" complaint, confirmed by reading `.tilegrid`/`.tile`'s own CSS (no
// explicit `align-items`, so grid's stretch default applies). Fix, per
// SPEC-layout-v3.md §8 Wave 1c item 5's option (c): each tile now renders a
// compact toggle BUTTON instead of a per-tile <details>, and there is
// exactly ONE shared `.tiledetail` region below the whole grid (a plain
// sibling, not a grid child) that renders whichever tile's disclosure
// content is currently active. A tile's own box in `.tilegrid` therefore
// never changes size when it (or any other tile) is expanded -- the grid's
// row heights are governed only by the five tiles' own fixed-height
// content, which never changes. `<button aria-expanded>` (not `<details>`)
// is used specifically because the expanded state and the expanded CONTENT
// now live in two different DOM locations (the button here, the content in
// the shared region below) -- `<details>` has no way to project its own
// content elsewhere, but `aria-expanded`/`aria-controls` is exactly the
// standard pattern for "this control's expanded state affects a distant
// region" (works with Enter/Space and screen readers, and with touch at
// mobile widths -- no hover-only path, matching the same tap-to-toggle
// requirement Wave 1b's <details> was chosen for).
//
// This same click-to-expand state also doubles as the map-highlight
// trigger for SPEC-layout-v3.md §8 Wave 1c item 4 ("hovered/expanded tile"),
// via `onTileHighlight` below -- see that prop's own comment.
export function CellReportView({
  cell,
  onTileHighlight,
}: {
  cell: CellProfile;
  // LAYOUT-V3 WAVE 1c item 4: called with whichever tile the map should
  // currently emphasize (a real hover, OR a real expanded disclosure -- see
  // `activeHighlight` below), or `null` once neither is true. Optional so
  // this component still works standalone in tests/Storybook-style
  // rendering with no map to drive.
  onTileHighlight?: (tile: TileHighlightKey | null) => void;
}) {
  const crime = cell.safety.crime;
  const hasBuildingAge = cell.building_age.median_year_built !== null;
  const totalAmenities = CATEGORY_LABELS.reduce((sum, [key]) => sum + cell.amenities.counts[key], 0);
  const violations = cell.housing_hazards.class_c_violations;

  const [hoveredKey, setHoveredKey] = useState<TileHighlightKey | null>(null);
  const [expandedKey, setExpandedKey] = useState<TileHighlightKey | null>(null);

  // LAYOUT-V3 WAVE 1d item 13 (2026-08-03, "why are the hexagons back" --
  // diagnosed live, not guessed: a real H3 cell polygon at 0.26 fill-
  // opacity + a 2px outline was staying parked on the map for as long as
  // ANY noise/trees/building tile's disclosure was expanded, even long
  // after the cursor moved away and the user was doing nothing else --
  // confirmed via Playwright: expanding "Living street trees", then moving
  // the mouse fully off the panel, left `tile-highlight-region`'s source
  // holding a real 6-point polygon indefinitely, visibly rendered on the
  // map at rest. This USED to also fall back to `expandedKey` (Wave 1c's
  // own "touch-equivalent path" for devices with no hover event) -- that
  // fallback is exactly the mechanism that kept a hex parked at rest, so it
  // is the fix: the map highlight now tracks only a REAL, LIVE hover
  // (`hoveredKey`), which by construction can never survive the cursor
  // actually leaving. A real, stated trade-off, not an oversight: a tap-to-
  // expand on a touch device (no hover event ever fires there) no longer
  // also highlights the map -- SPEC-layout-v3.md §8 Wave 1d's own
  // acceptance ("hexagons appear only when meaningful ... not at rest")
  // is the more load-bearing instruction than 1c's touch affordance, so
  // this wave resolves the conflict in its favour; touch-highlighting can
  // be revisited in a future wave if wanted.
  const activeHighlight = hoveredKey;

  useEffect(() => {
    onTileHighlight?.(activeHighlight);
    // Tell the map to drop any highlight left over from this component
    // unmounting (a new cell's own CellReportView will re-run this effect
    // with its own fresh state either way, but an explicit cleanup avoids
    // a one-frame stale highlight if the panel is ever removed outright).
    return () => onTileHighlight?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHighlight]);

  // A new block's report swaps in -- clear whatever hover/expand state the
  // PREVIOUS cell's tiles were in, so neither a stale highlight nor an
  // already-open disclosure (now showing the wrong block's numbers) can
  // survive the swap silently.
  useEffect(() => {
    setHoveredKey(null);
    setExpandedKey(null);
  }, [cell.h3]);

  function toggle(key: TileHighlightKey) {
    setExpandedKey((prev) => (prev === key ? null : key));
  }

  function hoverHandlers(key: TileHighlightKey) {
    return {
      onMouseEnter: () => setHoveredKey(key),
      onMouseLeave: () => setHoveredKey((prev) => (prev === key ? null : prev)),
    };
  }

  function disclosureToggle(key: TileHighlightKey) {
    const open = expandedKey === key;
    return (
      <button
        type="button"
        className="tile__disclosuretoggle"
        aria-expanded={open}
        aria-controls="tile-detail-panel"
        onClick={() => toggle(key)}
      >
        {open ? "− details" : "+ details"}
      </button>
    );
  }

  return (
    <div className="sidepanel__report">
      <div className="tilegrid">
        <article className="tile" aria-labelledby="cell-amenities-heading" {...hoverHandlers("amenities")}>
          <header className="tile__head">
            <h2 className="tile__title" id="cell-amenities-heading">
              Grocery &amp; everyday places
            </h2>
          </header>
          <p className="tile__value">
            <Stat value={totalAmenities} />
          </p>
          <p className="tile__sub">place{totalAmenities === 1 ? "" : "s"} counted nearby</p>
          {disclosureToggle("amenities")}
        </article>

        <article className="tile" aria-labelledby="cell-safety-heading" {...hoverHandlers("crime")}>
          <header className="tile__head">
            <h2 className="tile__title" id="cell-safety-heading">
              Crime near here
            </h2>
            {/* LAYOUT-V3 WAVE 1d item 1: the CONFIRMED-class stamp is gone
                from every tile -- it fired on essentially every load (a
                fixed badge saying "yes, this number is real" adds no new
                information once it's true almost always), which is exactly
                the visual-clutter complaint this wave's cut pass targets.
                NO_DATA stays: that's the one stamp state that still tells
                the user something they couldn't already see (None, not 0 --
                this project's own None-vs-0 invariant), so it renders only
                in that branch below, never the confirmed one. */}
            {!crime && <Stamp variant="no_data" compact />}
          </header>
          {!crime ? (
            <p className="tile__value tile__value--empty">We don&rsquo;t have crime data for this block yet.</p>
          ) : (
            <>
              <p className="tile__value tile__value--text">{crimeRelativeLabel(crime.crime_percentile)}</p>
              {disclosureToggle("crime")}
            </>
          )}
        </article>

        <article className="tile" aria-labelledby="cell-quiet-heading" {...hoverHandlers("noise")}>
          <header className="tile__head">
            <h2 className="tile__title" id="cell-quiet-heading">
              Noise complaints
            </h2>
          </header>
          <p className="tile__value">
            <Stat value={cell.noise.complaints_12mo} />
          </p>
          {/* LAYOUT-V3 WAVE 1d item 15 (Noah: "can we also get the
              relativity on noise soon") -- the raw count above stays the
              headline (never replaced, per this project's "count stays"
              rule from the 2026-08-02 noise-percentile report); this line
              adds the citywide relative framing right on the tile itself,
              not buried behind "+ details", so both truths are visible
              without an extra tap. `cell.noise.percentile` is real,
              already baked (cellprofile.py's `_bake_all()`, commit
              `0c39c5d`) -- this wave is the first to render it. */}
          <p className="tile__sub">
            reports, trailing 12mo · {formatPercentile(cell.noise.percentile)} citywide
          </p>
          {disclosureToggle("noise")}
        </article>

        <article className="tile" aria-labelledby="cell-green-heading" {...hoverHandlers("trees")}>
          <header className="tile__head">
            <h2 className="tile__title" id="cell-green-heading">
              Living street trees
            </h2>
          </header>
          <p className="tile__value">
            <Stat value={cell.trees.street_trees} />
          </p>
          <p className="tile__sub">counted in 2015</p>
          {disclosureToggle("trees")}
        </article>

        <article className="tile tile--wide" aria-labelledby="cell-building-heading" {...hoverHandlers("building")}>
          <header className="tile__head">
            <h2 className="tile__title" id="cell-building-heading">
              Building age &amp; serious hazards
            </h2>
            {!hasBuildingAge && <Stamp variant="no_data" compact />}
          </header>

          {!hasBuildingAge ? (
            <p className="tile__value tile__value--empty">We don&rsquo;t have property records for this block yet.</p>
          ) : (
            <div className="tile__valuerow">
              <span className="tile__value">
                <strong>{Math.round(cell.building_age.median_year_built as number)}</strong>
                {cell.building_age.era && <span className="era">{ERA_LABELS[cell.building_age.era]}</span>}
              </span>
              <span className={`tile__value${violations > 0 ? " tile__value--flag" : ""}`}>
                <Stat value={violations} suffix={violations === 1 ? "hazard flagged" : "hazards flagged"} />
              </span>
            </div>
          )}
          {disclosureToggle("building")}
        </article>
      </div>

      {/* The one shared detail region every tile's toggle button controls
          (SPEC-layout-v3.md §8 Wave 1c item 5, option (c)) -- a plain block
          BELOW `.tilegrid`, not one of its grid children, so it can never
          distort any tile's own geometry. Renders only the currently-
          expanded tile's content; every string below is byte-identical to
          what Wave 1b's per-tile <details> held (moved, not reworded). */}
      {expandedKey && (
        <div className="tiledetail" id="tile-detail-panel" role="region" aria-label={`${TILE_TITLES[expandedKey]} — more detail`}>
          <p className="tiledetail__title mono">{TILE_TITLES[expandedKey]}</p>

          {/* LAYOUT-V3 WAVE 1d item 10 (2026-08-03, Noah: "tile disclosures
              say WHAT the data is, not HOW it's acquired"). Every branch
              below now states exactly what the tile's own number means
              (the WHAT) plus its source name -- the full acquisition/
              methodology text each branch used to carry inline (how
              amenities are measured, noise/crime's citywide-percentile
              caveats, the tree count's "since 2015" gap, the HPD
              inspection note) moves verbatim to the disclosure page
              (App.tsx's DisclosurePage, item 14) rather than being deleted
              -- the app-level honesty inventory in the wave report tracks
              every one of those strings by its new home. */}
          {expandedKey === "amenities" && (
            <>
              <ul className="amenities">
                {CATEGORY_LABELS.map(([key, label]) => (
                  <li className="amenity" key={key}>
                    <span className="amenity__count">
                      <Stat value={cell.amenities.counts[key]} />
                    </span>
                    <span className="amenity__label">{label}</span>
                  </li>
                ))}
              </ul>
              <p className="field__provenance">
                Real, named places in this block.
                <br />
                <SourceTag source={cell.amenities.source} />
              </p>
            </>
          )}

          {expandedKey === "crime" && crime && (
            <p className="field__provenance">
              Ranks {formatPercentile(crime.crime_percentile)} for reported major crime, compared
              with the rest of New York City.
              <br />
              <SourceTag source={cell.safety.source} />
            </p>
          )}

          {expandedKey === "noise" && (
            <p className="field__provenance">
              Noise complaints neighbors reported to the city, trailing 12 months, in this block.
              <br />
              <SourceTag source={cell.noise.source} />
            </p>
          )}

          {expandedKey === "trees" && (
            <p className="field__provenance">
              From the city's last street-tree count, 2015, in this block.
              <br />
              <SourceTag source={cell.trees.source} />
            </p>
          )}

          {expandedKey === "building" && (
            <>
              {/* The year itself is not re-wrapped in its own <strong> here
                  (unlike the always-visible headline) -- purely so this
                  sentence's own text node doesn't exactly duplicate the
                  headline's isolated "1920"-style text node, which
                  App.test.tsx's getByText("1920") (a single-match query)
                  depends on staying unique in the DOM. The real fact (year
                  + era) is identical either way; only which element wraps
                  the number differs. */}
              {hasBuildingAge && (
                <p className="field__empty">
                  Most buildings here went up around {Math.round(cell.building_age.median_year_built as number)}
                  {cell.building_age.era && ` (${ERA_LABELS[cell.building_age.era]})`}.
                </p>
              )}
              <p className="field__empty">
                Serious safety problems flagged by the city, not fixed yet
                {violations > 0 && <em> — across every building on this block</em>}
              </p>
              <p className="field__provenance">
                <SourceTag source={cell.building_age.source} />
                <br />
                <SourceTag source={cell.housing_hazards.source} />
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
