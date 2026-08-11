import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, getCommute, getRoute } from "../api";
import { ANCHOR_COORDS } from "../lib/anchors";
import { crimeRelativeLabel, formatPercentile, ordinalSuffix } from "../lib/crime";
import { motionDelay, MOTION_FAST_MS } from "../lib/motion";
import { unreachableReasonSentence, unreachableReasonShortLabel } from "../lib/transit";
import { useAutocomplete } from "../lib/useAutocomplete";
import type { AutocompleteResult, CellProfile, RouteResult, RouteStep, UnreachableReason } from "../types";
import { Settle } from "./Settle";
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

// Same generous bar-scale ceiling TransitCard uses, for the same reason
// (see that component's own comment) -- kept as a separate constant rather
// than importing TransitCard's private one so the two components stay
// independently editable.
const BAR_SCALE_MAX_MIN = 60;

type AnchorKey = keyof CellProfile["transit"]["to_anchors"];

// LAYOUT-V3 WAVE 3 (2026-08-03, SPEC-layout-v3.md §5.1): one live-computed
// custom destination row -- added via the debounced autocomplete field
// below, backed by GET /api/commute (bearings/api.py's get_commute(),
// which shares profile._anchor_result() with the 4 baked ANCHORS -- see
// that endpoint's own docstring). `lat`/`lng`/`minutes`/`reason` are
// `null` only while the very first fetch for this row is in flight --
// never a placeholder value; a genuinely unreachable destination gets a
// real `minutes: -1` + a real `reason`, matching the 4 defaults' own
// contract exactly (types.ts's ToAnchors/UnreachableReasons).
interface CustomDestination {
  id: string;
  /** The exact string re-sent to GET /api/commute on every cell change --
   * either a picked autocomplete suggestion's own label, or free-typed
   * text submitted directly (mirrors AddressSearch.tsx's own dual submit
   * path: pick a suggestion, or just hit enter on typed text). */
  query: string;
  label: string;
  lat: number | null;
  lng: number | null;
  minutes: number | null;
  reason: UnreachableReason | null;
  loading: boolean;
  error: string | null;
}

function newDestinationId(): string {
  return `dest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): one line of plain-language
// nav-directions copy per real RouteStep -- every number/name here comes
// straight from GET /api/route (a real Dijkstra path + real GTFS trips),
// never fabricated. A ride's "toward" falls back to its own destination
// station name when GTFS carries no trip_headsign for that trip (a real
// gap, not hidden -- still names a real place either way).
function stepLabel(step: RouteStep): string {
  switch (step.type) {
    case "walk_to_station":
      return `Walk to ${step.to} (~${step.minutes} min)`;
    case "ride":
      return `Take the ${step.route ?? "train"} toward ${step.headsign ?? step.to} (${step.minutes} min)`;
    case "transfer":
      return `Transfer at ${step.at} (~${step.minutes} min)`;
    case "walk_to_destination":
      return `Walk toward the destination (~${step.minutes} min)`;
  }
}

// LAYOUT-V3 WAVE 3 item: the add-destination field -- reuses
// lib/useAutocomplete.ts (the exact debounce/suggestion machinery
// AddressSearch.tsx's own search bar already established), per SPEC-
// layout-v3.md §5.1's explicit "reuse it... don't build a second
// typeahead" instruction. A separate component (not inlined into
// GettingAroundField) purely so its own `value` state doesn't force the
// whole getting-around field to re-render on every keystroke.
function AddDestinationField({ onAdd }: { onAdd: (query: string) => void }) {
  const [value, setValue] = useState("");
  const inputId = useId();
  const { suggestions, suggestionsOpen, setSuggestionsOpen, suppress } = useAutocomplete(value);

  function submit(query: string) {
    const trimmed = query.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    suppress(trimmed);
    setValue("");
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit(value);
  }

  function pick(s: AutocompleteResult) {
    submit(s.label);
  }

  return (
    <form className="anchors__add" onSubmit={handleSubmit} role="search">
      <label className="sr-only" htmlFor={inputId}>
        Add a destination
      </label>
      <div className="anchors__addfield">
        <input
          id={inputId}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Add a destination — an office, a gym, a friend's place"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setSuggestionsOpen(suggestions.length > 0)}
          onBlur={() => {
            // Same short-delay reasoning as AddressSearch.tsx's own input --
            // otherwise blur fires before a suggestion's onClick registers.
            window.setTimeout(() => setSuggestionsOpen(false), 150);
          }}
          role="combobox"
          aria-expanded={suggestionsOpen}
          aria-controls={`${inputId}-suggestions`}
          aria-autocomplete="list"
        />
        <button type="submit" disabled={value.trim().length === 0}>
          + add
        </button>
      </div>
      {suggestionsOpen && (
        <ul className="anchors__suggestions" id={`${inputId}-suggestions`} role="listbox">
          {suggestions.map((s) => (
            <li key={`${s.label}-${s.lat}-${s.lng}`}>
              <button
                type="button"
                className="anchors__suggestion"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

// "Getting around" -- the one transit field.
//
// LAYOUT-V3 WAVE 1f item 4 (2026-08-11, SPEC-layout-v3.md §8, "primary"
// option): moved BACK into the side panel, below the tile grid -- Wave 1/3's
// own reasoning above ("moved out of the side panel deliberately... needs
// real width, not a narrow column") no longer held once Wave 1e dropped the
// panel to four tiles, leaving the panel column genuinely shorter than the
// map and real unused vertical room at its own bottom. The 4-column desktop
// `.anchor` grid this wave's own predecessor used doesn't fit a 360px panel
// (9.5rem+8rem+1.4rem of fixed columns alone is ~304px, leaving almost
// nothing for the bar itself) -- this component's own row markup is
// unchanged from Wave 3, but index.css's `.anchor` rule is rewritten to the
// stacked (label+delete / track / value) layout this file's mobile
// breakpoint already proved legible at an even narrower width (298px usable
// at 375px viewport, per that rule's own pre-1f measurements) -- see
// index.css's own comment on `.anchor` for the exact reasoning.
//
// LAYOUT-V3 WAVE 3 (2026-08-03, SPEC-layout-v3.md §5): the 4 baked ANCHORS
// stay on their existing fast path (cell.transit.to_anchors, a pure baked-
// JSON field -- untouched by anything below) and are now individually
// removable from VIEW ("deletable from view is fine — but their baked data
// path stays" per the dispatch); users can also add live-computed custom
// destinations (GET /api/commute) and remove those too. Hovering or
// clicking any bar (default or custom) reports its real point up via
// `onDestinationHighlight`, which MapView.tsx turns into a straight-line
// zone preview (SPEC-layout-v3.md §5.3) -- see that prop's own comment.
export function GettingAroundField({
  cell,
  onDestinationHighlight,
  onRouteHighlight,
}: {
  cell: CellProfile;
  onDestinationHighlight?: (point: { lat: number; lng: number } | null) => void;
  // WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): the real GTFS shape_id(s)
  // for the currently active (hovered/selected) destination's actual ridden
  // line(s) -- MapView.tsx draws these instead of the straight-line zone
  // preview when the route-lines toggle is on and a real route exists.
  // `null` whenever there's nothing to highlight (toggle off, no active
  // destination, or the active one has no real transit component) --
  // MapView falls back to the existing zone preview in every one of those
  // cases, never a blank map.
  onRouteHighlight?: (shapeIds: string[] | null) => void;
}) {
  const anchorEntries = Object.entries(cell.transit.to_anchors) as [AnchorKey, number][];

  // Anchors hidden from view (Wave 3's "deletable from view" -- the baked
  // to_anchors data itself is never touched, only what's rendered here).
  // Deliberately session-scoped, NOT reset when `cell` changes -- hiding
  // "Newport, NJ (PATH)" is a preference about what the user wants to see
  // across every block they browse, not a fact about one specific block.
  const [hiddenAnchors, setHiddenAnchors] = useState<Set<AnchorKey>>(new Set());
  const [customDestinations, setCustomDestinations] = useState<CustomDestination[]>([]);
  // Same session-scoped reasoning as hiddenAnchors -- a user's added
  // destinations (and which one they're currently looking at) survive a
  // cell swap; only the computed MINUTES for each one are recomputed per
  // cell (see the recompute effect below).
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): zone-only vs route-lines,
  // session-scoped like hiddenAnchors above -- a display preference about
  // how this user wants to see previews across every block, not a fact
  // about one specific block. Defaults off: the straight-line zone preview
  // is the existing, already-shipped behavior; route lines are the new,
  // opt-in view.
  const [routeLinesOn, setRouteLinesOn] = useState(false);
  // (cell.h3, activeKey) -> the real GET /api/route result, "loading", or
  // "error". Fetched lazily, once per pair, the first time that pair
  // becomes active (hovered or selected) -- never on every render, and
  // never for a row nobody has looked at yet.
  const [routeCache, setRouteCache] = useState<Record<string, RouteResult | "loading" | "error">>({});
  const requestedRouteKeysRef = useRef<Set<string>>(new Set());

  // Motion wave item 1 ("deleted rows exit fast, ~150ms") -- a row marked
  // here is STILL a real member of `visibleAnchorEntries`/`customDestinations`
  // (it renders exactly as before, plus a `.anchor--exiting` class), so it
  // stays on screen fading out for MOTION_FAST_MS before hideAnchor()/
  // removeDestination() (below) actually mutate `hiddenAnchors`/
  // `customDestinations`. `pendingRemovalsRef` tracks every scheduled
  // setTimeout id so unmounting this component (a cell swap doesn't unmount
  // it, but the whole side panel disappearing -- no report loaded -- does)
  // clears them rather than calling setState on a gone component.
  const [removingAnchors, setRemovingAnchors] = useState<Set<AnchorKey>>(new Set());
  const [removingDestinationIds, setRemovingDestinationIds] = useState<Set<string>>(new Set());
  const pendingRemovalsRef = useRef<number[]>([]);

  useEffect(() => {
    return () => {
      pendingRemovalsRef.current.forEach((id) => window.clearTimeout(id));
      pendingRemovalsRef.current = [];
    };
  }, []);

  // Always-current ref -- the recompute effect below fires on `cell.h3`
  // alone (never `customDestinations`, or adding a destination on the SAME
  // cell would immediately re-trigger it in a loop); it needs whichever
  // destinations exist AT THE MOMENT the cell actually changes, which this
  // ref (updated on every render) always holds. Same "stale closure"
  // reasoning MapView.tsx's own onCellClickRef/geoRef already document.
  const customDestinationsRef = useRef<CustomDestination[]>(customDestinations);
  customDestinationsRef.current = customDestinations;

  const visibleAnchorEntries = anchorEntries.filter(([key]) => !hiddenAnchors.has(key));

  // Every anchor OR custom destination that failed carries its own real
  // reason (web/src/types.ts's UnreachableReason) -- collapse to the
  // DISTINCT reasons actually present among what's currently VISIBLE, so a
  // shared cause only prints one explanation, not one per row (matches the
  // pre-Wave-3 behaviour for the 4 defaults exactly; extended here to
  // custom rows using the identical reason codes, never a fabricated third
  // one -- see profile.commute_to_point()'s own docstring for the one
  // known, honestly-flagged asymmetry this reuse creates).
  const distinctUnreachableReasons = Array.from(
    new Set(
      [
        ...visibleAnchorEntries.map(([key]) => cell.transit.unreachable_reason[key]),
        ...customDestinations.map((d) => d.reason),
      ].filter((reason): reason is UnreachableReason => reason !== null)
    )
  );

  // LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.2 Option A+C): fetch a fresh
  // commute for every existing custom destination whenever the ORIGIN cell
  // changes -- the minute values are per-(cell, destination), so a new
  // cell genuinely needs a new number. GET /api/commute's own session
  // cache (profile.commute_to_point(), keyed on (cell, resolved point))
  // makes re-visiting an already-seen cell for the same destination a
  // cache hit rather than a second Dijkstra run. Skips entirely on first
  // mount (nothing to recompute yet) and whenever there are no custom
  // rows at all.
  useEffect(() => {
    const current = customDestinationsRef.current;
    if (current.length === 0) return;
    let cancelled = false;
    const ids = current.map((d) => d.id);
    setCustomDestinations((prev) =>
      prev.map((d) => (ids.includes(d.id) ? { ...d, loading: true, error: null } : d)),
    );
    Promise.all(
      current.map((d) =>
        getCommute(cell.h3, d.query)
          .then((result) => ({ id: d.id, result, error: null as string | null }))
          .catch((e: unknown) => ({
            id: d.id,
            result: null,
            error: e instanceof ApiError ? e.message : "Something went wrong finding that destination.",
          })),
      ),
    ).then((outcomes) => {
      if (cancelled) return;
      setCustomDestinations((prev) =>
        prev.map((d) => {
          const outcome = outcomes.find((o) => o.id === d.id);
          if (!outcome) return d;
          if (outcome.result) {
            return {
              ...d,
              label: outcome.result.destination.label,
              lat: outcome.result.destination.lat,
              lng: outcome.result.destination.lng,
              minutes: outcome.result.minutes,
              reason: outcome.result.reason,
              loading: false,
              error: null,
            };
          }
          return { ...d, loading: false, error: outcome.error };
        }),
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell.h3]);

  function addDestination(query: string) {
    const id = newDestinationId();
    setCustomDestinations((prev) => [
      ...prev,
      { id, query, label: query, lat: null, lng: null, minutes: null, reason: null, loading: true, error: null },
    ]);
    getCommute(cell.h3, query)
      .then((result) => {
        setCustomDestinations((prev) =>
          prev.map((d) =>
            d.id === id
              ? {
                  ...d,
                  label: result.destination.label,
                  lat: result.destination.lat,
                  lng: result.destination.lng,
                  minutes: result.minutes,
                  reason: result.reason,
                  loading: false,
                  error: null,
                }
              : d,
          ),
        );
      })
      .catch((e: unknown) => {
        setCustomDestinations((prev) =>
          prev.map((d) =>
            d.id === id
              ? {
                  ...d,
                  loading: false,
                  error: e instanceof ApiError ? e.message : "Something went wrong finding that destination.",
                }
              : d,
          ),
        );
      });
  }

  function removeDestination(id: string) {
    // Un-highlight/deselect IMMEDIATELY (the row is visibly leaving; a stale
    // map preview for a row that's mid-exit would be its own small honesty
    // gap), but the actual array mutation waits for the exit transition.
    setHoveredKey((prev) => (prev === id ? null : prev));
    setSelectedKey((prev) => (prev === id ? null : prev));
    setRemovingDestinationIds((prev) => new Set(prev).add(id));
    const timeoutId = window.setTimeout(() => {
      setCustomDestinations((prev) => prev.filter((d) => d.id !== id));
      setRemovingDestinationIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, motionDelay(MOTION_FAST_MS));
    pendingRemovalsRef.current.push(timeoutId);
  }

  function hideAnchor(key: AnchorKey) {
    setHoveredKey((prev) => (prev === key ? null : prev));
    setSelectedKey((prev) => (prev === key ? null : prev));
    setRemovingAnchors((prev) => new Set(prev).add(key));
    const timeoutId = window.setTimeout(() => {
      setHiddenAnchors((prev) => new Set(prev).add(key));
      setRemovingAnchors((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, motionDelay(MOTION_FAST_MS));
    pendingRemovalsRef.current.push(timeoutId);
  }

  // LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.3): reports the currently
  // hovered-or-selected bar's real point up to MapView, whichever is
  // active (hover wins while it's live, matching CellReportView's own
  // established `hoveredKey ?? ...` precedent for tiles -- but see item
  // 13's own comment on WHY that fallback was removed there: unlike a
  // tile's map highlight, a "selected" bar here has its own persistent,
  // visible on-row state (`.anchor--selected`), so it does not recreate
  // the "stuck at rest with no visible cause" bug that fix addressed).
  const activeKey = hoveredKey ?? selectedKey;
  useEffect(() => {
    if (!onDestinationHighlight) return;
    if (!activeKey) {
      onDestinationHighlight(null);
      return;
    }
    const anchorPoint = ANCHOR_COORDS[activeKey as AnchorKey];
    if (anchorPoint) {
      onDestinationHighlight(anchorPoint);
      return;
    }
    const custom = customDestinations.find((d) => d.id === activeKey);
    if (custom && custom.lat !== null && custom.lng !== null) {
      onDestinationHighlight({ lat: custom.lat, lng: custom.lng });
    } else {
      onDestinationHighlight(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, customDestinations]);

  useEffect(() => {
    return () => {
      onDestinationHighlight?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): lazily fetch GET
  // /api/route the first time a (cell, destination) pair genuinely needs
  // one -- computed live, on demand, per that endpoint's own docstring,
  // never on a bare hover with the route-lines toggle off (which would
  // fire a live Dijkstra-adjacent request on every mouse pass for no
  // visible benefit). `fetchKey` is the active (hover-or-select) key while
  // the toggle is ON -- so the map line can preview whatever's currently
  // hovered -- but narrows to the SELECTED key alone while the toggle is
  // OFF, since the only reason to fetch at all in that state is the
  // nav-directions panel, which only ever shows a selected (clicked) row.
  // Powers BOTH the map highlight and the directions panel from this one
  // shared fetch. `customDestinationsRef` (not `customDestinations` in the
  // dep array) so this never re-fires from a destination edit alone -- same
  // stale-closure-avoidance pattern the cell-swap recompute effect above
  // already established.
  const fetchKey = routeLinesOn ? activeKey : selectedKey;
  useEffect(() => {
    if (!fetchKey) return;
    const cacheKey = `${cell.h3}:${fetchKey}`;
    if (requestedRouteKeysRef.current.has(cacheKey)) return;

    const anchorPoint = ANCHOR_COORDS[fetchKey as AnchorKey];
    let req: Promise<RouteResult> | null = null;
    if (anchorPoint) {
      req = getRoute(cell.h3, { anchorKey: fetchKey });
    } else {
      // A brand-new custom destination's own commute lookup (GET
      // /api/commute, the effect above) may still be resolving its real
      // lat/lng at the exact moment this destination first becomes active
      // -- `custom.lat`/`lng` are null until that resolves. `customDestinations`
      // (not just `customDestinationsRef`) is a REAL dependency below
      // specifically so this effect re-evaluates once that resolution
      // lands, even when `fetchKey` itself never changes value across that
      // transition (hovering/selecting the same still-resolving row) --
      // without it, a destination hovered/selected before its own commute
      // finished would never get a second chance to fetch its route.
      const custom = customDestinationsRef.current.find((d) => d.id === fetchKey);
      if (custom && custom.lat !== null && custom.lng !== null) {
        req = getRoute(cell.h3, { destLat: custom.lat, destLng: custom.lng });
      }
    }
    if (!req) return;

    // `requestedRouteKeysRef` (not a `cancelled`-flag cleanup like the
    // custom-destination recompute effect above) is this effect's own
    // dedup guard -- deliberately NOT paired with a cancel-on-cleanup flag.
    // React StrictMode's dev-only double-invoke (mount -> cleanup -> mount)
    // runs this effect twice for the identical `fetchKey`; a `cancelled`
    // flag on the FIRST closure would be set true by StrictMode's own
    // cleanup pass before that closure's real, already-in-flight request
    // resolves -- and since `requestedRouteKeysRef` (a ref, not re-created
    // by StrictMode's fake remount) already marked the key requested, the
    // SECOND closure skips dispatching a new one and never registers its
    // own `.then()` either. Net effect: a real request fires, a real 200
    // comes back, and no surviving closure is left to write it into
    // `routeCache` -- the panel is stuck on "Finding the real route…"
    // forever (found live via Playwright screenshot verification,
    // 2026-08-11). Writing the result unconditionally is safe here: this
    // ref already guarantees at most one real request per cacheKey, so
    // there is no genuinely stale write to guard against, only this
    // StrictMode artifact to avoid re-introducing.
    requestedRouteKeysRef.current.add(cacheKey);
    setRouteCache((prev) => ({ ...prev, [cacheKey]: "loading" }));
    req
      .then((result) => {
        setRouteCache((prev) => ({ ...prev, [cacheKey]: result }));
      })
      .catch(() => {
        setRouteCache((prev) => ({ ...prev, [cacheKey]: "error" }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey, cell.h3, customDestinations]);

  const activeRoute = activeKey ? routeCache[`${cell.h3}:${activeKey}`] : undefined;
  const selectedRoute = selectedKey ? routeCache[`${cell.h3}:${selectedKey}`] : undefined;

  // WAVE 4: forwards the real shape_id(s) up to MapView ONLY when the
  // toggle is on and the active destination's route genuinely used a
  // transit ride -- every other case (toggle off, nothing active, still
  // loading, or a real "no route" result) reports null so MapView's
  // existing zone preview (driven by onDestinationHighlight above,
  // unchanged) is what shows. Never draws a route line from a walk-only or
  // unreachable destination -- SPEC-layout-v3.md Wave 4's own binding rule.
  useEffect(() => {
    if (!onRouteHighlight) return;
    if (
      routeLinesOn &&
      activeRoute &&
      typeof activeRoute === "object" &&
      activeRoute.reachable &&
      activeRoute.shape_ids.length > 0
    ) {
      onRouteHighlight(activeRoute.shape_ids);
    } else {
      onRouteHighlight(null);
    }
  }, [routeLinesOn, activeRoute, onRouteHighlight]);

  useEffect(() => {
    return () => {
      onRouteHighlight?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function rowHandlers(key: string) {
    return {
      onMouseEnter: () => setHoveredKey(key),
      onMouseLeave: () => setHoveredKey((prev) => (prev === key ? null : prev)),
      onClick: () => setSelectedKey((prev) => (prev === key ? null : key)),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setSelectedKey((prev) => (prev === key ? null : key));
        }
      },
    };
  }

  return (
    <div className="sidepanel__anchorswrap">
      {/* LAYOUT-V3 WAVE 1f item 5 (2026-08-11, SPEC-layout-v3.md §8, Noah:
          "the bars with destination names are self-explanatory"). The
          "GETTING AROUND" heading, its CONFIRMED stamp (the one stamp that
          survived Wave 1d's tile-stamp cut -- this card is a `.field`, not
          a `.tile`, so item 1's cut never reached it until now), and the
          "RIDE TIME TO —" label are all gone outright, not relocated --
          each named place already appears as its own row label right next
          to a real minute value, so none of the three added information a
          reader didn't already have from the rows themselves (the same
          "does removing this make the next user action harder? No" test
          Wave 1c's own cut pass established). `aria-label` keeps the exact
          same accessible name ("Getting around") a screen reader had
          before, now on the article itself since there's no visible
          heading left for `aria-labelledby` to point at. */}
      <article className="tile tile--anchors" aria-label="Getting around">
        {/* WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): the route-lines
            toggle -- reuses .mapfield__toggle (this app's one existing
            aria-pressed toggle-button idiom, freed up when Wave 1d cut the
            control row it originally styled) rather than inventing a new
            control shape. Off by default: the straight-line zone preview
            (already shipped) stays what a user sees until they explicitly
            ask for the real line. */}
        <button
          type="button"
          className="mapfield__toggle anchors__routetoggle"
          aria-pressed={routeLinesOn}
          onClick={() => setRouteLinesOn((v) => !v)}
        >
          {routeLinesOn ? "Route lines: on" : "Route lines: off"}
        </button>
        <div className="anchors">
          {visibleAnchorEntries.map(([key, minutes]) => {
            const reachable = minutes >= 0;
            const pct = reachable ? Math.min(100, (minutes / BAR_SCALE_MAX_MIN) * 100) : 0;
            const reason = cell.transit.unreachable_reason[key];
            const selected = selectedKey === key;
            const exiting = removingAnchors.has(key);
            return (
              <div
                className={`anchor${selected ? " anchor--selected" : ""}${exiting ? " anchor--exiting" : ""}`}
                key={key}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                {...rowHandlers(key)}
              >
                <span className="anchor__label" title={ANCHOR_LABELS[key]}>
                  {ANCHOR_LABELS[key]}
                </span>
                <span className="anchor__track">
                  {/* Motion wave item 1: always rendered (never conditionally
                      omitted) so a mount-to-mount TRANSFORM change is what
                      animates the bar, not a mount/unmount pop -- see
                      index.css's own .anchor__fill comment. */}
                  <span className="anchor__fill" style={{ transform: `scaleX(${pct / 100})` }} />
                </span>
                <span className={`anchor__value${reachable ? "" : " anchor__value--nodata"}`}>
                  {reachable ? `${minutes} min` : unreachableReasonShortLabel(reason as UnreachableReason)}
                </span>
                <button
                  type="button"
                  className="anchor__delete"
                  aria-label={`Remove ${ANCHOR_LABELS[key]} from this list`}
                  onClick={(e) => {
                    e.stopPropagation();
                    hideAnchor(key);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}

          {customDestinations.map((d) => {
            const reachable = d.minutes !== null && d.minutes >= 0;
            const pct = reachable ? Math.min(100, ((d.minutes as number) / BAR_SCALE_MAX_MIN) * 100) : 0;
            const selected = selectedKey === d.id;
            const exiting = removingDestinationIds.has(d.id);
            return (
              <div
                className={`anchor anchor--custom${selected ? " anchor--selected" : ""}${exiting ? " anchor--exiting" : ""}`}
                key={d.id}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                {...rowHandlers(d.id)}
              >
                <span className="anchor__label" title={d.label}>
                  {d.label}
                </span>
                <span className="anchor__track">
                  <span className="anchor__fill" style={{ transform: `scaleX(${pct / 100})` }} />
                </span>
                <span className={`anchor__value${reachable ? "" : " anchor__value--nodata"}`}>
                  {d.loading
                    ? "computing…"
                    : d.error
                      ? "error"
                      : reachable
                        ? `${d.minutes} min`
                        : unreachableReasonShortLabel(d.reason as UnreachableReason)}
                </span>
                <button
                  type="button"
                  className="anchor__delete"
                  aria-label={`Remove ${d.label} from this list`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeDestination(d.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        {/* WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): nav directions --
            the real step sequence GET /api/route computed for whichever
            destination is CLICKED (selectedKey, not merely hovered -- a
            deliberate action, not something that flashes on every mouse
            pass). One shared region below the row list, same "shared
            detail region, not per-row" idiom item 5's tile disclosures
            already established, for the identical reason: it never
            distorts any row's own geometry. */}
        {selectedKey && (
          <div className="directions">
            {selectedRoute === "loading" || selectedRoute === undefined ? (
              <p className="directions__status">Finding the real route…</p>
            ) : selectedRoute === "error" ? (
              <p className="directions__status">Could not compute directions for this destination.</p>
            ) : !selectedRoute.reachable ? (
              <p className="directions__status">{unreachableReasonSentence(selectedRoute.reason as UnreachableReason)}</p>
            ) : (
              <>
                <ol className="directions__steps">
                  {selectedRoute.steps?.map((step, i) => <li key={i}>{stepLabel(step)}</li>)}
                </ol>
                <p className="directions__caveat">
                  Walk legs are straight-line estimates, not turn-by-turn street directions — this
                  codebase has no pedestrian street graph.
                </p>
              </>
            )}
          </div>
        )}

        {customDestinations.some((d) => d.error) && (
          <p className="anchor__error" role="alert">
            {customDestinations.find((d) => d.error)?.error}
          </p>
        )}

        <AddDestinationField onAdd={addDestination} />

        {distinctUnreachableReasons.length > 0 && (
          <p className="field__caveat mono">
            <span className="field__caveat-kicker" aria-hidden="true">
              why
            </span>
            {distinctUnreachableReasons.map(unreachableReasonSentence).join(" ")}
          </p>
        )}

        <p className="field__provenance">
          Real MTA/PATH schedules · weekday 8am departure · fastest route to every destination in
          this list, default or added.
          <br />
          <SourceTag source={cell.transit.source} />
        </p>
      </article>
    </div>
  );
}

// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 4): which
// map subject each tile's disclosure "talks about" -- MapView.tsx reads this
// same key to decide what to emphasize. Deliberately just the tile
// identities, not a richer shape: the map-side effect that consumes this
// still has to independently decide WHETHER real client-side geometry exists
// for a given key (see MapView.tsx's own "tile highlight" effect comment for
// the amenities-tile gap this can't paper over from here).
//
// LAYOUT-V3 WAVE 1e (2026-08-03, SPEC-layout-v3.md §8, Noah: "what's
// stopping us from searching up every livable building and mapping that
// out"): "building" is REMOVED from this union -- building age and open
// housing hazards leave the tile grid entirely and become their own map
// interaction (a real per-building record on hover/click, not a block-wide
// average tile) -- see MapView.tsx's own buildBuildingInfoElement() for
// where that content now lives.
export type TileHighlightKey = "amenities" | "crime" | "noise" | "trees";

// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 5): the
// human-readable title for whichever tile's disclosure is currently showing
// in the shared detail region below the grid -- see that region's own
// comment for why a shared region replaced Wave 1b's per-tile <details>.
const TILE_TITLES: Record<TileHighlightKey, string> = {
  amenities: "Grocery & everyday places",
  crime: "Crime near here",
  noise: "Noise complaints",
  trees: "Living street trees",
};

// The four non-transit fields -- grocery/amenities, crime, noise, trees --
// rendered beside the map in the side panel (SPEC-layout-v3.md §3/§4).
// Building age and open housing hazards used to be a fifth tile here
// (LAYOUT-V3 WAVE 1e removed it -- see TileHighlightKey's own comment).
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
  const totalAmenities = CATEGORY_LABELS.reduce((sum, [key]) => sum + cell.amenities.counts[key], 0);

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
            <Settle settleKey={totalAmenities}>
              <Stat value={totalAmenities} />
            </Settle>
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
              {/* UX-FIX 2026-08-03 (audit finding #8, "crime tile breaks the
                  tile grid's visual scan rhythm"): the other three tiles
                  all lead with a bold numeral (Stat) the eye lands on first,
                  with the descriptive text as .tile__sub below; crime alone
                  led with a prose sentence and no numeral at all. This adds
                  the same real, already-computed percentile the noise tile
                  already shows as its own sub-line (crime.crime_percentile,
                  not a new number) as the bold headline -- the underlying
                  "relative category, not a raw crime count" policy
                  (VISUAL.md §5) is unchanged; only WHICH already-real number
                  leads is different. */}
              <p className="tile__value">
                <Settle settleKey={Math.round(crime.crime_percentile)}>
                  {Math.round(crime.crime_percentile)}
                  <span className="tile__value-ordinal">{ordinalSuffix(Math.round(crime.crime_percentile))}</span>
                </Settle>
              </p>
              <p className="tile__sub">{crimeRelativeLabel(crime.crime_percentile)}</p>
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
            <Settle settleKey={cell.noise.complaints_12mo}>
              <Stat value={cell.noise.complaints_12mo} />
            </Settle>
          </p>
          {/* LAYOUT-V3 WAVE 1d item 15 (Noah: "can we also get the
              relativity on noise soon") -- the raw count above stays the
              headline (never replaced, per this project's "count stays"
              rule from the 2026-08-02 noise-percentile report); this line
              adds the citywide relative framing right on the tile itself,
              not buried behind "+ details", so both truths are visible
              without an extra tap. `cell.noise.percentile` is real,
              already baked (cellprofile.py's `_bake_all()`, commit
              `0c39c5d`) -- this wave is the first to render it.
              MOTION WAVE item 4 ("percentile/noise displays: same settle
              idiom as tile values") -- only the percentile PHRASE settles,
              not the whole sentence around it, matching the "headline
              numeral" scope items 2/4 both describe, scaled down to a
              sub-value. */}
          <p className="tile__sub">
            reports, trailing 12mo ·{" "}
            <Settle settleKey={cell.noise.percentile}>{formatPercentile(cell.noise.percentile)}</Settle> citywide
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
            <Settle settleKey={cell.trees.street_trees}>
              <Stat value={cell.trees.street_trees} />
            </Settle>
          </p>
          <p className="tile__sub">counted in 2015</p>
          {disclosureToggle("trees")}
        </article>

        {/* LAYOUT-V3 WAVE 1e (2026-08-03, SPEC-layout-v3.md §8, Noah:
            "what's stopping us from searching up every livable building and
            mapping that out"): the "Building age & serious hazards" tile
            (formerly here, `tile--wide`, a cell-wide median year + summed
            Class C count) is REMOVED, not hidden -- that cell-level average
            is exactly what Noah's question objected to ("we're not directly
            searching up exact buildings"). The real per-building numbers
            now live on the map itself: every residential building's own
            footprint is its own real year/hazard record, on hover/click
            (MapView.tsx's buildBuildingInfoElement()). Nothing here was
            deleted without a new home -- see this app's "How this data
            works" disclosure page, whose "Building age & serious hazards"
            section now describes the map interaction directly. */}
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
                Real, named places in this block only.
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
              Noise complaints neighbors reported to the city, trailing 12 months · in this block.
              <br />
              <SourceTag source={cell.noise.source} />
            </p>
          )}

          {expandedKey === "trees" && (
            <p className="field__provenance">
              From the city's last street-tree count, 2015 · in this block.
              <br />
              <SourceTag source={cell.trees.source} />
            </p>
          )}

        </div>
      )}
    </div>
  );
}
