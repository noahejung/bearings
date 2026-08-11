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

// LAYOUT-V3 WAVE 1f item 5 (2026-08-11, SPEC-layout-v3.md §8, Noah: "the
// walk-rings caveat paragraph sits exposed below the map ... cut down all
// this fluff"). MapView.tsx used to render `geo.basemap_note` and
// `reach.method_note` as two always-visible paragraphs directly below the
// map; both now live here instead, behind the map's own small "How this
// map is made" link -- verbatim, not deleted (this project's honesty rule
// applies at the app level, same precedent Wave 1d item 14 already set for
// the tile disclosures). Hardcoded rather than threaded down from
// MapView's own `geo`/`reach` state: unlike TRANSIT_CAVEAT/CRIME_CAVEAT
// above, both source constants (mapgeo.py's BASEMAP_NOTE, reach.py's
// METHOD_NOTE) are plain module-level Python string literals with no
// per-cell/per-address variation at all -- there is no "real live value"
// this mirror could ever drift out of sync WITH, unlike the tree-source
// citation that genuinely did drift once (see this file's own top comment).
// Grepped live from the real backend source, 2026-08-11, same "Mirrors
// bearings/X.py's Y" citation convention as every other fallback above.
const BASEMAP_METHOD_NOTE =
  "Everything on this map is real. The base layer -- streets, land, water -- is OpenStreetMap, a free public map. Everything on top is computed fresh from the city's own records: building outlines and streets from city property maps, subway/PATH lines from the transit agencies' own schedules, plus five per-block numbers (noise complaints, nearby places, street trees, building age, transit stations) -- each cited to its real source elsewhere in this report, nothing estimated. Click any home or apartment building for its own real year built and safety-violation record, not just the block's average.";
const REACH_METHOD_NOTE =
  "Roughly how far you could walk in 5, 10, and 15 minutes at a normal pace (about 3 mph) -- a straight line from the address, not an actual route, so it can overreach near rivers, parks, highways, or a long block.";

// LAYOUT-V3 WAVE 1f item 2 (2026-08-11, SPEC-layout-v3.md §8): the zone-
// preview caption that used to render below the map ONLY while hovering a
// getting-around destination (and reserved its own box the rest of the
// time, to avoid a real, live-diagnosed layout-shift bug -- see MapView.tsx
// and index.css's own comments where that box used to live). Moved here
// verbatim -- same text, same source (MapView.tsx's own former
// `DESTINATION_PREVIEW_NOTE` constant, grepped live 2026-08-11 before it
// was deleted), never reworded.
const DESTINATION_PREVIEW_NOTE =
  "Roughly how far you could walk from this destination in 5, 10, and 15 minutes — a straight line, not an actual route, the same approximation used for the rings around a searched address.";

interface Section {
  title: string;
  what: string;
  // A real, per-cell data fact (not methodology) that used to sit inline in
  // the pre-Wave-1d tile disclosure -- optional because only crime/building
  // age carry one today (crime's own week_ending/total_ytd sentence;
  // building age's own median-year/hazard-count sentence, LAYOUT-V3 WAVE
  // 1e). Kept as its own field rather than folded into `what`, so a section
  // with no loaded cell (and therefore no real fact to state) simply omits
  // this paragraph instead of showing a stale or fabricated placeholder.
  detail?: string;
  // LAYOUT-V3 WAVE 1f item 2: "Reading the map" is the one section carrying
  // THREE real, previously-separate paragraphs (basemap note, reach-ring
  // note, destination zone-preview note) rather than the usual one-fact
  // `detail` -- optional, same "omit rather than fabricate" reasoning as
  // `detail`/`source2` above, unused by every other section.
  detail2?: string;
  how: string;
  source: { name: string; url: string } | null;
  // LAYOUT-V3 WAVE 1e: "Building age & serious hazards" is the one section
  // whose real data comes from TWO datasets (PLUTO for year built, HPD for
  // hazards) -- `source` alone would only ever cite one. Optional so every
  // other section (still genuinely one dataset each) is unaffected.
  source2?: { name: string; url: string } | null;
}

const ERA_LABELS: Record<string, string> = { prewar: "Pre-war", postwar: "Post-war", modern: "Modern" };

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

  // LAYOUT-V3 WAVE 1e (2026-08-03, SPEC-layout-v3.md §8): the real fact this
  // section's tile used to carry ("Most buildings here went up around
  // {year}... Serious safety problems flagged... across every building on
  // this block") — same underlying two facts (median year/era, open Class C
  // count), composed fresh for this page's own standalone context rather
  // than moved verbatim, the same precedent crimeDetail above already sets
  // (its own wording differs from the tile's pre-move crime disclosure too).
  // Still baked and served on every real cell (bearings/cellprofile.py's
  // building_age/housing_hazards, unchanged by this wave) even though no
  // tile renders it any more -- the per-building map interaction is the
  // primary way to see this now, but the block-wide average stays reachable
  // here rather than vanishing outright.
  const buildingDetail =
    cell && cell.building_age.median_year_built !== null
      ? `Most buildings on this block went up around ${Math.round(cell.building_age.median_year_built)}${
          cell.building_age.era ? ` (${ERA_LABELS[cell.building_age.era] ?? cell.building_age.era})` : ""
        } — ${cell.housing_hazards.class_c_violations} open, serious safety violation${
          cell.housing_hazards.class_c_violations === 1 ? "" : "s"
        } across every building on this block.`
      : undefined;

  const sections: Section[] = [
    {
      // LAYOUT-V3 WAVE 1f item 5: the honest home for the two paragraphs
      // that used to sit exposed below the map itself, not tied to any one
      // of the six per-block metrics below -- see this file's own
      // BASEMAP_METHOD_NOTE/REACH_METHOD_NOTE comment.
      title: "Reading the map",
      what: BASEMAP_METHOD_NOTE,
      detail: REACH_METHOD_NOTE,
      detail2: DESTINATION_PREVIEW_NOTE,
      how: "Neither approximation routes around rivers, parks, or highways -- both are straight-line distance at a normal walking pace, not a real path.",
      source: { name: "Protomaps Basemap (OpenStreetMap + Natural Earth)", url: "https://docs.protomaps.com/basemaps/downloads" },
    },
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
      // LAYOUT-V3 WAVE 1e (2026-08-03, SPEC-layout-v3.md §8, Noah: "what's
      // stopping us from searching up every livable building and mapping
      // that out"): building age/hazards are no longer a side-panel tile at
      // all -- click any home or apartment building on the map for its own
      // real record, not a block-wide average. `detail` below keeps the
      // block-wide average itself reachable (it's still real, baked data),
      // just reframed as background context rather than the primary way to
      // see it.
      title: "Building age & serious hazards",
      what: "Click any home or apartment building on the map for its own real year built and open, serious (Class C) safety violations — not a block-wide average.",
      detail: buildingDetail,
      how: cell ? cell.housing_hazards.note : FALLBACK_HAZARD_NOTE,
      source: cell ? cell.building_age.source : null,
      source2: cell ? cell.housing_hazards.source : null,
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
            {s.detail2 && <p className="disclosure__what">{s.detail2}</p>}
            <p className="disclosure__how">{s.how}</p>
            {s.source && (
              <p className="disclosure__source">
                <SourceTag source={s.source} />
                {s.source2 && <SourceTag source={s.source2} />}
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
