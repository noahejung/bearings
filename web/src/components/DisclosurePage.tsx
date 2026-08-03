import type { CellProfile } from "../types";
import { SourceTag } from "./SourceTag";

// LAYOUT-V3 WAVE 1d item 14 (2026-08-03, SPEC-layout-v3.md §8): the honest
// home for every methodology/caveat/source string item 10 cut out of the
// side-panel tiles' disclosures ("tiles say WHAT, not HOW"). The app-level
// honesty rule (SPEC-layout-v3.md §7: "every word currently in a
// stat-card provenance line must remain reachable... after this ships")
// holds HERE, at the app level, not per-tile -- every caveat this page
// prints is byte-identical to text that used to live inline in
// CellReportView.tsx before this wave (see that file's own item-10 comment
// for the per-tile before/after), never reworded, never dropped.
//
// Two real sources feed this page's copy, and they're deliberately treated
// differently:
//   - Amenities' "measured as a straight line" note and trees' "since 2015"
//     gap were ALWAYS pure frontend text (not part of the GET /api/cell
//     contract -- CellAmenities/CellTrees carry no caveat field) -- these
//     two are hardcoded constants below, moved verbatim from
//     CellReportView.tsx, same as this file's own established
//     "Mirrors bearings/config.py's NYC_BBOX" convention elsewhere in this
//     codebase for text that has no live API source to read from.
//   - Transit/crime/noise/hazards' caveats (`TRANSIT_CAVEAT`,
//     `CRIME_RELATIVE_CAVEAT`, `noise.caveat`, `HAZARD_NOTE`) ARE part of
//     the API contract (CellTransit.caveat, CellSafety.crime_caveat,
//     CellNoise.caveat, CellHousingHazards.note) -- when a real `cell` is
//     loaded, this page reads them straight from it (zero drift risk,
//     always the exact text this build's own bake actually shipped).
//     `_FALLBACK_*` below exist only for the page's very first render,
//     before any address has ever been searched or block clicked -- a
//     live-grepped mirror of each constant's CURRENT source text (cited by
//     file + name, same convention), accepted with the same trade-off
//     NYC_BBOX/WALK_SPEED_MPS already carry: this project caught its own
//     tree-source citation drifting once already (2026-08-03, confirmed
//     live while building this page) precisely because a hardcoded mirror
//     can go stale -- which is exactly why the REAL cell's own fields are
//     preferred whenever one is available, and these fallbacks are a
//     last-resort, not the primary path.
const AMENITIES_METHOD_NOTE =
  "Measured as a straight line, not an actual route, so it can over- or under-count near rivers, parks, or highways.";
// Byte-identical to CellReportView.tsx's own pre-Wave-1d trees disclosure
// text ("From the city's last street-tree count, 2015 · in this block.
// Trees planted since won't show here.") -- the "in this block" half moved
// into the tile's own WHAT sentence instead, so only the remaining
// methodology clause lives here, unreworded.
const TREES_METHOD_NOTE = "From the city's last street-tree count, 2015. Trees planted since won't show here.";

// Mirrors bearings/transit.py's TRANSIT_CAVEAT (grepped live 2026-08-03).
const FALLBACK_TRANSIT_CAVEAT =
  "Train time, plus a few minutes per transfer. Excludes the walk to the station and the wait for a train — the fastest possible time, not a real door-to-door estimate.";
// Mirrors bearings/citywide.py's CRIME_RELATIVE_CAVEAT (grepped live 2026-08-03).
const FALLBACK_CRIME_CAVEAT =
  "Ranks raw crime counts between police areas, not per person -- no per-area population figure exists, so a busy commercial area with few residents can rank like a crowded residential one. Counts also reflect policing and reporting levels, not just crime, and area boundaries are coarse, not block by block.";
// Mirrors bearings/cellprofile.py's NOISE_PERCENTILE_CAVEAT (grepped live 2026-08-03).
const FALLBACK_NOISE_CAVEAT =
  "Ranks this block's 311 noise complaints against every block citywide, though complaint volume reflects who calls 311 as much as real noise and rises faster in gentrifying neighborhoods.";
// Mirrors bearings/cellprofile.py's HAZARD_NOTE (grepped live 2026-08-03).
const FALLBACK_HAZARD_NOTE =
  "Counts only the most serious violation class (\"immediately hazardous,\" the city's top severity rating), summed across every building on this block. Added only after an HPD (Housing Preservation and Development) inspector confirms it in person -- a step up from a raw, unverified complaint. Reflects inspection and reporting frequency, not necessarily every real issue: a 0 means no verified hazard on record, not that none exists.";

interface Section {
  title: string;
  what: string;
  // A real, per-cell data fact (not methodology) that used to sit inline in
  // the pre-Wave-1d tile disclosure -- optional because only crime carries
  // one today (its own week_ending/total_ytd sentence). Kept as its own
  // field rather than folded into `what`, so a section with no loaded cell
  // (and therefore no real fact to state) simply omits this paragraph
  // instead of showing a stale or fabricated placeholder.
  detail?: string;
  how: string;
  source: { name: string; url: string } | null;
}

export function DisclosurePage({ cell, onBack }: { cell: CellProfile | null; onBack: () => void }) {
  // Byte-identical to CellReportView.tsx's own pre-Wave-1d crime disclosure
  // sentence ("NYPD crime data, week ending {week_ending} · {total_ytd}
  // major crimes so far this year in this area.") -- a real per-cell data
  // fact, not methodology, so it wasn't a natural fit for either the tile's
  // one WHAT sentence or the "how" methodology field; it gets its own
  // paragraph here instead of being silently dropped.
  const crimeDetail =
    cell && cell.safety.crime
      ? `NYPD crime data, week ending ${cell.safety.crime.week_ending} — ${cell.safety.crime.total_ytd.toLocaleString()} major crimes so far this year in this area.`
      : undefined;

  const sections: Section[] = [
    {
      title: "Getting around",
      what: "Real MTA/PATH schedules, weekday 8am departure, fastest route to four key destinations in the city.",
      how: cell ? cell.transit.caveat : FALLBACK_TRANSIT_CAVEAT,
      source: cell ? cell.transit.source : null,
    },
    {
      title: "Grocery & everyday places",
      what: "Real, named places in this block only.",
      how: AMENITIES_METHOD_NOTE,
      source: cell ? cell.amenities.source : null,
    },
    {
      title: "Crime near here",
      what: "Ranks this block's precinct by reported major crime, compared with the rest of New York City.",
      detail: crimeDetail,
      how: cell ? cell.safety.crime_caveat : FALLBACK_CRIME_CAVEAT,
      source: cell ? cell.safety.source : null,
    },
    {
      title: "Noise complaints",
      what: "Noise complaints neighbors reported to the city, trailing 12 months, in this block — count and citywide percentile both shown on the tile.",
      how: cell ? cell.noise.caveat : FALLBACK_NOISE_CAVEAT,
      source: cell ? cell.noise.source : null,
    },
    {
      title: "Living street trees",
      what: "The number of living street trees counted in this block.",
      how: TREES_METHOD_NOTE,
      source: cell ? cell.trees.source : null,
    },
    {
      title: "Building age & serious hazards",
      what: "Median year built and open, serious (Class C) safety violations for buildings in this block.",
      how: cell ? cell.housing_hazards.note : FALLBACK_HAZARD_NOTE,
      source: cell ? cell.building_age.source : null,
    },
  ];

  return (
    <section className="disclosure" aria-labelledby="disclosure-heading">
      <header className="disclosure__head">
        <button type="button" className="button button--ghost disclosure__back" onClick={onBack}>
          ← Back
        </button>
        <h2 className="disclosure__title" id="disclosure-heading">
          How this data works
        </h2>
        <p className="disclosure__lede">
          What each number on the record means, how it's measured, and where it comes from —
          the full explanation behind every tile's short version.
        </p>
      </header>

      <div className="disclosure__sections">
        {sections.map((s) => (
          <article className="disclosure__section" key={s.title} aria-labelledby={`disclosure-${s.title}`}>
            <h3 className="disclosure__sectiontitle" id={`disclosure-${s.title}`}>
              {s.title}
            </h3>
            <p className="disclosure__what">{s.what}</p>
            {s.detail && <p className="disclosure__what">{s.detail}</p>}
            <p className="disclosure__how">{s.how}</p>
            {s.source && (
              <p className="disclosure__source">
                <SourceTag source={s.source} />
              </p>
            )}
            {!s.source && (
              <p className="disclosure__source disclosure__source--pending mono">
                Search an address or click a block on the map to see this section's exact
                source citation for that record.
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
