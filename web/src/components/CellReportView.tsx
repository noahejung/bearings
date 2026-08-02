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

function stationCountLabel(n: number): string {
  if (n === 0) return "No subway or PATH station within about a 6-minute walk of this block.";
  return `${n} subway or PATH station${n === 1 ? "" : "s"} within about a 6-minute walk of this block's centre.`;
}

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
              amenities/noise/trees below. Previously scoped to
              `stations_within_500m > 0`, a real but much narrower fact (no
              station within ~500m) that isn't "no data": a cell with zero
              nearby stations can still show four fully-populated ride times
              via farther stations, and used to show a red NO DATA badge
              above them anyway (2026-07-28 UX audit finding #4). That
              narrower fact still has its own honest sentence right below,
              via stationCountLabel() -- it never needed the card-level
              stamp's visual authority. */}
          <Stamp variant="confirmed" compact />
        </header>

        <p className="field__empty">{stationCountLabel(cell.transit.stations_within_500m)}</p>

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

        <p className="field__caveat mono">
          <span className="field__caveat-kicker" aria-hidden="true">
            note
          </span>
          {cell.transit.caveat} Calculated from this block&rsquo;s centre — not one specific
          building&rsquo;s front door.
        </p>
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
// headline value/verdict, the existing stamp, and a tap-to-toggle
// `<details>` disclosure -- everything that isn't the headline value
// (every consequence sentence, caveat, provenance paragraph, and source
// citation this file rendered before) moves verbatim inside that
// `<details>`, per the spec's explicit "zero strings deleted" rule. This is
// an INTERIM home for that text (Wave 2 still owns building the real
// tooltip/disclosure-page split per §4.2) -- `<details>/<summary>` was
// chosen here specifically because it's tap-to-toggle by construction (no
// hover-only affordance, keyboard-operable, works at 375px) without
// needing new JS state.
export function CellReportView({ cell }: { cell: CellProfile }) {
  const crime = cell.safety.crime;
  const hasBuildingAge = cell.building_age.median_year_built !== null;
  const totalAmenities = CATEGORY_LABELS.reduce((sum, [key]) => sum + cell.amenities.counts[key], 0);
  const violations = cell.housing_hazards.class_c_violations;

  return (
    <div className="tilegrid">
      <article className="tile" aria-labelledby="cell-amenities-heading">
        <header className="tile__head">
          <h2 className="tile__title" id="cell-amenities-heading">
            Grocery &amp; everyday places
          </h2>
          <Stamp variant="confirmed" compact />
        </header>
        <p className="tile__value">
          <Stat value={totalAmenities} />
        </p>
        <p className="tile__sub">place{totalAmenities === 1 ? "" : "s"} counted nearby</p>
        <details className="tile__disclosure">
          <summary>details</summary>
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
            Real, named places in this block only — measured as a straight line, not an
            actual route, so it can over- or under-count near rivers, parks, or highways.
            <br />
            <SourceTag source={cell.amenities.source} />
          </p>
        </details>
      </article>

      <article className="tile" aria-labelledby="cell-safety-heading">
        <header className="tile__head">
          <h2 className="tile__title" id="cell-safety-heading">
            Crime near here
          </h2>
          <Stamp variant={crime ? "confirmed" : "no_data"} compact />
        </header>
        {!crime ? (
          <p className="tile__value tile__value--empty">We don&rsquo;t have crime data for this block yet.</p>
        ) : (
          <>
            <p className="tile__value tile__value--text">{crimeRelativeLabel(crime.crime_percentile)}</p>
            <details className="tile__disclosure">
              <summary>details</summary>
              <p className="field__empty">
                Ranks {formatPercentile(crime.crime_percentile)} for reported major crime, compared
                with the rest of New York City.
              </p>
              <p className="field__provenance">
                NYPD crime data, week ending {crime.week_ending} · {crime.total_ytd.toLocaleString()}{" "}
                major crimes so far this year in this area.
                <br />
                {cell.safety.crime_caveat}
                <br />
                <SourceTag source={cell.safety.source} />
              </p>
            </details>
          </>
        )}
      </article>

      <article className="tile" aria-labelledby="cell-quiet-heading">
        <header className="tile__head">
          <h2 className="tile__title" id="cell-quiet-heading">
            Noise complaints
          </h2>
          <Stamp variant="confirmed" compact />
        </header>
        <p className="tile__value">
          <Stat value={cell.noise.complaints_12mo} />
        </p>
        <p className="tile__sub">reports, trailing 12mo</p>
        <details className="tile__disclosure">
          <summary>details</summary>
          <p className="field__provenance">
            Noise complaints neighbors reported to the city, trailing 12 months · in this block.
            <br />
            <SourceTag source={cell.noise.source} />
          </p>
        </details>
      </article>

      <article className="tile" aria-labelledby="cell-green-heading">
        <header className="tile__head">
          <h2 className="tile__title" id="cell-green-heading">
            Living street trees
          </h2>
          <Stamp variant="confirmed" compact />
        </header>
        <p className="tile__value">
          <Stat value={cell.trees.street_trees} />
        </p>
        <p className="tile__sub">counted in 2015</p>
        <details className="tile__disclosure">
          <summary>details</summary>
          <p className="field__provenance">
            From the city's last street-tree count, 2015 · in this block. Trees planted
            since won't show here.
            <br />
            <SourceTag source={cell.trees.source} />
          </p>
        </details>
      </article>

      <article className="tile tile--wide" aria-labelledby="cell-building-heading">
        <header className="tile__head">
          <h2 className="tile__title" id="cell-building-heading">
            Building age &amp; serious hazards
          </h2>
          <Stamp variant={hasBuildingAge ? "confirmed" : "no_data"} compact />
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

        <details className="tile__disclosure">
          <summary>details</summary>
          {/* The year itself is not re-wrapped in its own <strong> here (unlike
              the always-visible headline above) -- purely so this sentence's
              own text node doesn't exactly duplicate the headline's isolated
              "1920"-style text node, which App.test.tsx's getByText("1920")
              (a single-match query) depends on staying unique in the DOM. The
              real fact (year + era) is identical either way; only which
              element wraps the number differs. */}
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
            {cell.housing_hazards.note}
            <br />
            <SourceTag source={cell.building_age.source} />
            <br />
            <SourceTag source={cell.housing_hazards.source} />
          </p>
        </details>
      </article>
    </div>
  );
}
