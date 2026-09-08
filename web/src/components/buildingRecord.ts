// The "Building record" block inside the per-building click-card
// (SPEC-building-card-v2.md Part A's card-wiring paragraph). Five rows, one
// per source, each in one of three states -- a value, "no record", or
// "unavailable" -- plus a loading state while GET /api/building/{bbl} is in
// flight.
//
// Its own module rather than more DOM-building inside MapView.tsx for one
// reason that matters: MapView.tsx imports maplibre-gl, which needs a real
// WebGL context, so nothing in that file is reachable from a jsdom test.
// Everything here is a pure function over plain data plus one hand-built
// DOM element, which is testable directly -- and the three states are
// exactly the thing that needs a test.
//
// Hand-built DOM, not JSX, because this element lives behind a
// `maplibregl.Marker` on the map canvas, matching this app's established
// idiom for map-anchored info (`.mapstation`, `.savedmarker`, and the
// existing `.buildinginfo` card this block is appended to).
//
// THE RULE THIS FILE EXISTS TO HOLD: "no record" and "unavailable" are
// different facts and must never render as the same words. A building whose
// rodent lookup timed out has not passed an inspection. See
// bearings/buildingrecord.py's module docstring.

import type { BuildingRecord } from "../types";
import { isUnavailable } from "../types";

export type RecordState =
  | { status: "loading" }
  | { status: "ready"; record: BuildingRecord }
  | { status: "error"; message: string };

// "flag" is the one tone that colours a value red, and it is reserved for a
// real adverse finding -- an infested unit, a failed inspection, a Special
// Flood Hazard Area. Never used for "unavailable": a source being down is
// not bad news about the building.
export type RecordTone = "value" | "flag" | "empty" | "unavailable" | "loading";

export interface RecordRow {
  key: string;
  label: string;
  value: string;
  tone: RecordTone;
  /** The full sentence behind a short row -- the timeout reason, the FEMA
   *  zone description, the 311 attribution caveat. Rendered as `title`, so
   *  the short row never has to carry the whole fact. */
  detail?: string;
}

const LABELS: Record<string, string> = {
  bedbugs: "Bedbugs",
  rodents: "Rodents",
  heat: "Heat",
  flood: "Flood",
  pavement: "Streets",
};

export const ROW_KEYS = ["bedbugs", "rodents", "heat", "flood", "pavement"] as const;

function loadingRow(key: string): RecordRow {
  return { key, label: LABELS[key], value: "checking…", tone: "loading" };
}

function unavailableRow(key: string, reason: string): RecordRow {
  return {
    key,
    label: LABELS[key],
    // Deliberately not "none", "clear", "0", or anything a reader could
    // mistake for a clean result. This says we could not look.
    value: "not available",
    tone: "unavailable",
    detail: reason,
  };
}

function bedbugRow(field: BuildingRecord["bedbugs"]): RecordRow {
  if (isUnavailable(field)) return unavailableRow("bedbugs", field.reason);
  if (field === null) {
    return {
      key: "bedbugs",
      label: LABELS.bedbugs,
      value: "no filing on record",
      tone: "empty",
      detail:
        "This building has never filed the annual bedbug report NYC Admin Code 27-2018.1 requires. That is not the same as a filing that reported none.",
    };
  }
  const infested = field.units_infested;
  const total = field.units_total;
  const period = field.period_end ? ` Filing period ended ${field.period_end}.` : "";
  if (infested !== null && infested > 0) {
    return {
      key: "bedbugs",
      label: LABELS.bedbugs,
      value: total !== null ? `${infested} of ${total} units` : `${infested} units`,
      tone: "flag",
      detail: `${field.filings} filing${field.filings === 1 ? "" : "s"} on record.${period}`,
    };
  }
  return {
    key: "bedbugs",
    label: LABELS.bedbugs,
    value: "filed, none infested",
    tone: "value",
    detail: `${field.filings} filing${field.filings === 1 ? "" : "s"} on record.${period}`,
  };
}

function rodentRow(field: BuildingRecord["rodents"], months: number): RecordRow {
  if (isUnavailable(field)) return unavailableRow("rodents", field.reason);
  if (field === null) {
    return {
      key: "rodents",
      label: LABELS.rodents,
      value: `not inspected in ${months} months`,
      tone: "empty",
      detail:
        "No DOHMH initial or compliance inspection on record for this lot in the window. That is not the same as passing one.",
    };
  }
  const detail = `Most recent: ${field.last_result}, ${field.last_date}. Counts initial and compliance visits only -- the ones that carry a pass/fail verdict.`;
  if (field.failed > 0) {
    return {
      key: "rodents",
      label: LABELS.rodents,
      value: `${field.failed} of ${field.inspections} failed`,
      tone: "flag",
      detail,
    };
  }
  return {
    key: "rodents",
    label: LABELS.rodents,
    value: `${field.inspections} passed`,
    tone: "value",
    detail,
  };
}

function heatRow(heat: BuildingRecord["heat"]): RecordRow {
  const season =
    heat.season_start && heat.season_end
      ? `Heating season ${heat.season_start} to ${heat.season_end}. `
      : "";
  // Never "no record": the bake counted every heat complaint in the city
  // for the whole season, so zero here is a measured zero.
  if (heat.complaints === 0) {
    return {
      key: "heat",
      label: LABELS.heat,
      value: "no complaints",
      tone: "value",
      detail: `${season}${heat.caveat}`,
    };
  }
  return {
    key: "heat",
    label: LABELS.heat,
    value: `${heat.complaints} 311 complaint${heat.complaints === 1 ? "" : "s"}`,
    tone: "flag",
    detail: `${season}${heat.caveat}`,
  };
}

function floodRow(field: BuildingRecord["flood"]): RecordRow {
  if (isUnavailable(field)) return unavailableRow("flood", field.reason);
  if (field === null) {
    return {
      key: "flood",
      label: LABELS.flood,
      value: "no FEMA study here",
      tone: "empty",
      detail:
        "No FEMA flood study covers this point. That is not the same as being mapped and found low-risk.",
    };
  }
  const bfe =
    field.base_flood_elevation_ft !== null
      ? ` Base flood elevation ${field.base_flood_elevation_ft} ft.`
      : "";
  return {
    key: "flood",
    label: LABELS.flood,
    value: field.in_special_flood_hazard_area
      ? `Zone ${field.zone}, high risk`
      : `Zone ${field.zone}`,
    tone: field.in_special_flood_hazard_area ? "flag" : "value",
    detail: `${field.description}${bfe}`,
  };
}

function pavementRow(field: BuildingRecord["pavement"]): RecordRow {
  if (isUnavailable(field)) return unavailableRow("pavement", field.reason);
  if (field === null) {
    return {
      key: "pavement",
      label: LABELS.pavement,
      value: "no rated street nearby",
      tone: "empty",
      detail:
        "No street segment within 250 m carries a real DOT rating -- a private or gated street, or simply none rated. DOT's own 0 means 'not rated this pass', and is excluded rather than counted as a zero.",
    };
  }
  return {
    key: "pavement",
    label: LABELS.pavement,
    value: `${field.average_rating.toFixed(1)} of 10`,
    tone: field.poor > field.good ? "flag" : "value",
    detail: `${field.segments_rated} segments within 250 m: ${field.good} good, ${field.fair} fair, ${field.poor} poor. Most recent inspection ${field.most_recent_inspection}.`,
  };
}

export function recordRows(state: RecordState): RecordRow[] {
  if (state.status === "loading") return ROW_KEYS.map(loadingRow);
  if (state.status === "error") {
    return ROW_KEYS.map((k) => unavailableRow(k, state.message));
  }
  const r = state.record;
  const months = !isUnavailable(r.rodents) && r.rodents !== null ? r.rodents.months : 24;
  return [
    bedbugRow(r.bedbugs),
    rodentRow(r.rodents, months),
    heatRow(r.heat),
    floodRow(r.flood),
    pavementRow(r.pavement),
  ];
}

/** The sources line for the five record rows, split by vintage rather than
 *  listed flat: two of the five are read from a build-time bake and three
 *  are fetched live on the click, and a reader is entitled to know that a
 *  bedbug count and a flood zone are not equally fresh. Returns [] while
 *  loading or on error -- citing a source for numbers that never arrived
 *  would be the wrong kind of confident. */
export function recordSourceLines(state: RecordState): string[] {
  if (state.status !== "ready") return [];
  const baked: string[] = [];
  const live: string[] = [];
  let bakedAsOf: string | null = null;
  let liveAsOf: string | null = null;
  for (const key of ROW_KEYS) {
    const src = state.record.sources[key];
    if (!src) continue;
    if (src.baked) {
      baked.push(src.name);
      bakedAsOf = src.as_of;
    } else {
      live.push(src.name);
      liveAsOf = src.as_of;
    }
  }
  const lines: string[] = [];
  if (baked.length) lines.push(`${baked.join(" · ")} — baked ${bakedAsOf ?? "date unknown"}`);
  if (live.length) lines.push(`${live.join(" · ")} — live ${liveAsOf ?? "today"}`);
  return lines;
}

const TONE_CLASS: Record<RecordTone, string> = {
  value: "",
  flag: "buildinginfo__record-value--flag",
  empty: "buildinginfo__record-value--empty",
  unavailable: "buildinginfo__record-value--unavailable",
  loading: "buildinginfo__record-value--loading",
};

/** Builds the block and returns an `update` that re-renders it in place, so
 *  the card can go loading -> values without being torn down and rebuilt
 *  (which on a map marker would visibly re-anchor the popup). */
export function buildRecordBlock(initial: RecordState = { status: "loading" }): {
  el: HTMLDivElement;
  update: (state: RecordState) => void;
} {
  const el = document.createElement("div");
  el.className = "buildinginfo__record";

  const heading = document.createElement("p");
  heading.className = "buildinginfo__record-heading mono";
  heading.textContent = "Building record";
  el.appendChild(heading);

  const grid = document.createElement("dl");
  grid.className = "buildinginfo__record-grid";
  el.appendChild(grid);

  const sources = document.createElement("div");
  sources.className = "buildinginfo__record-sources";
  el.appendChild(sources);

  const update = (state: RecordState) => {
    grid.replaceChildren();
    for (const row of recordRows(state)) {
      const dt = document.createElement("dt");
      dt.className = "buildinginfo__record-label";
      dt.textContent = row.label;
      const dd = document.createElement("dd");
      dd.className = `buildinginfo__record-value ${TONE_CLASS[row.tone]}`.trim();
      dd.textContent = row.value;
      dd.dataset.state = row.tone;
      dd.dataset.row = row.key;
      if (row.detail) dd.title = row.detail;
      grid.appendChild(dt);
      grid.appendChild(dd);
    }

    sources.replaceChildren();
    for (const line of recordSourceLines(state)) {
      const p = document.createElement("p");
      p.className = "buildinginfo__source mono";
      p.textContent = line;
      sources.appendChild(p);
    }
  };

  update(initial);
  return { el, update };
}
