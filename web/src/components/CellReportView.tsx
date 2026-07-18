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

export function CellReportView({ cell }: { cell: CellProfile }) {
  const anchorEntries = Object.entries(cell.transit.to_anchors) as [
    keyof CellProfile["transit"]["to_anchors"],
    number,
  ][];
  const crime = cell.safety.crime;
  const hasBuildingAge = cell.building_age.median_year_built !== null;

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
          <Stamp variant={cell.transit.stations_within_500m > 0 ? "confirmed" : "no_data"} compact />
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
          {cell.transit.caveat} Calculated from this block&rsquo;s centre to the nearest stations —
          not from one specific building&rsquo;s front door.
        </p>
        <p className="field__provenance">
          Real MTA and PATH train schedules · typical weekday 8am departure · fastest calculated
          route to four key destinations in the city.
          <br />
          <SourceTag source={cell.transit.source} />
        </p>
      </article>

      <article className="field" aria-labelledby="cell-amenities-heading">
        <header className="field__head">
          <div>
            <h2 className="field__title" id="cell-amenities-heading">
              Grocery &amp; everyday places
            </h2>
          </div>
          <Stamp variant="confirmed" compact />
        </header>
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
          Overture Maps Places, current release · counted in this block only — can over- or
          under-count near rivers, parks, or highways.
          <br />
          <SourceTag source={cell.amenities.source} />
        </p>
      </article>

      <article className="field" aria-labelledby="cell-safety-heading">
        <header className="field__head">
          <div>
            <h2 className="field__title" id="cell-safety-heading">
              Crime near here
            </h2>
          </div>
          <Stamp variant={crime ? "confirmed" : "no_data"} compact />
        </header>
        {!crime ? (
          <p className="field__empty">We don&rsquo;t have crime data for this block yet.</p>
        ) : (
          <>
            <p className="safety-relative">
              <span className="safety-relative__label">{crimeRelativeLabel(crime.crime_percentile)}</span>
              <span className="safety-relative__detail">
                Ranks {formatPercentile(crime.crime_percentile)} for reported major crime, compared
                with the rest of New York City.
              </span>
            </p>
            <p className="field__provenance">
              NYPD crime data, week ending {crime.week_ending} · {crime.total_ytd.toLocaleString()}{" "}
              major crimes so far this year in this area.
              <br />
              {cell.safety.crime_caveat}
              <br />
              <SourceTag source={cell.safety.source} />
            </p>
          </>
        )}
      </article>

      <article className="field" aria-labelledby="cell-quiet-heading">
        <header className="field__head">
          <div>
            <h2 className="field__title" id="cell-quiet-heading">
              Noise complaints
            </h2>
          </div>
          <Stamp variant="confirmed" compact />
        </header>
        <p className="headline">
          <Stat value={cell.noise.complaints_12mo} />
        </p>
        <p className="field__provenance">
          Noise complaints neighbors reported to the city, trailing 12 months · in this block.
          <br />
          <SourceTag source={cell.noise.source} />
        </p>
      </article>

      <article className="field" aria-labelledby="cell-green-heading">
        <header className="field__head">
          <div>
            <h2 className="field__title" id="cell-green-heading">
              Living street trees
            </h2>
          </div>
          <Stamp variant="confirmed" compact />
        </header>
        <p className="headline">
          <Stat value={cell.trees.street_trees} />
        </p>
        <p className="field__provenance">
          2015 Street Tree Census · in this block.
          <br />
          <SourceTag source={cell.trees.source} />
        </p>
      </article>

      <article className="field" aria-labelledby="cell-building-heading">
        <header className="field__head">
          <div>
            <h2 className="field__title" id="cell-building-heading">
              Building age &amp; serious hazards
            </h2>
          </div>
          <Stamp variant={hasBuildingAge ? "confirmed" : "no_data"} compact />
        </header>

        {!hasBuildingAge ? (
          <p className="field__empty">We don&rsquo;t have property records for this block yet.</p>
        ) : (
          <p className="building__facts">
            Most buildings here went up around{" "}
            <strong>{Math.round(cell.building_age.median_year_built as number)}</strong>
            {cell.building_age.era && <span className="era">{ERA_LABELS[cell.building_age.era]}</span>}
          </p>
        )}

        <div className="violations">
          <div
            className={`violation${cell.housing_hazards.class_c_violations > 0 ? " violation--flag" : ""}`}
          >
            <span className="violation__count">
              <Stat value={cell.housing_hazards.class_c_violations} />
            </span>
            <span className="violation__label">
              Serious safety problems flagged by the city, not fixed yet
              {cell.housing_hazards.class_c_violations > 0 && <em> — across every building on this block</em>}
            </span>
          </div>
        </div>

        <p className="field__provenance">
          {cell.housing_hazards.note}
          <br />
          <SourceTag source={cell.building_age.source} />
          <br />
          <SourceTag source={cell.housing_hazards.source} />
        </p>
      </article>
    </div>
  );
}
