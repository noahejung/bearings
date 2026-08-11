import { useState } from "react";
import { ApiError, getCell, getGeocode, postFactcheck } from "./api";
import { AddressSearch } from "./components/AddressSearch";
import { CellReportView, GettingAroundField, type TileHighlightKey } from "./components/CellReportView";
import { DisclosurePage } from "./components/DisclosurePage";
import { FactCheckView } from "./components/FactCheckView";
import { MapView } from "./components/MapView";
import { PreferenceBar } from "./components/PreferenceBar";
import { EXAMPLE_LISTING_ADDRESS, EXAMPLE_LISTING_TEXT } from "./data/examples";
import type { PinnedPlace } from "./lib/preferences";
import type { CellProfile, FactcheckResult } from "./types";

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

// SPEC-precompute-v2.md Phase 2 (2026-07-15): the report now ALWAYS loads
// from the precomputed GET /api/cell/{h3} (well under 1s), never the live
// GET /api/profile (measured 6-10s) -- both the "click any hex" and
// "search an address" paths below resolve to a cell first, then call the
// exact same fast endpoint. /api/profile stays live and callable on the
// backend for whenever a future phase needs true per-building detail (see
// the dispatch's own "Keep /api/profile callable" note) -- this file just
// no longer calls it.
export default function App() {
  const [addressInput, setAddressInput] = useState("");

  // The cell currently driving the report panel + map emphasis, and the
  // real address that resolved it -- kept as SEPARATE state because they
  // can genuinely disagree: a bare grid click has a cell but no address
  // (see CellReportView.tsx's own comment on why that's a deliberately
  // different, honest shape from the old building-level report), so
  // `searchedAddress` stays `null` for a click rather than fabricating an
  // "about this address" framing for a location nobody searched.
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [searchedAddress, setSearchedAddress] = useState<string | null>(null);
  const [cellReport, setCellReport] = useState<CellProfile | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const [listingText, setListingText] = useState(EXAMPLE_LISTING_TEXT);
  const [factcheckResult, setFactcheckResult] = useState<FactcheckResult | null>(null);
  const [factcheckLoading, setFactcheckLoading] = useState(false);
  const [factcheckError, setFactcheckError] = useState<string | null>(null);

  // The preference bar's own state (SPEC-lens-report.md §2) -- session-only,
  // plain useState, no persistence of any kind (no localStorage, no URL
  // encoding, no accounts -- "every visit starts clean"). Lifted here
  // because both PreferenceBar (the controls) and MapView (the rendering)
  // need to read/write it.
  const [activeCategories, setActiveCategories] = useState<Set<string>>(new Set());
  const [pins, setPins] = useState<PinnedPlace[]>([]);
  const [pinLoading, setPinLoading] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  // LAYOUT-V3 WAVE 1d item 14 (2026-08-03, SPEC-layout-v3.md §8): the
  // methodology/disclosure page -- a real, separate app view (not a scroll
  // target), toggled here rather than routed, since this app has no router
  // dependency (matches the existing "no react-router" shape rather than
  // adding one for a single extra screen). `false` = the normal report
  // view; `true` = DisclosurePage replaces the whole <main>.
  const [showDisclosure, setShowDisclosure] = useState(false);

  // LAYOUT-V3 WAVE 1c item 4: which side-panel tile (if any) the map should
  // currently emphasize -- CellReportView owns the hover/expand logic
  // itself and reports just this one key up via onTileHighlight; MapView
  // reads it (plus its own reach/citywide/selectedCell state) to decide
  // what real geometry, if any, to draw. See MapView.tsx's own
  // tileHighlightGeometry() for why "if any" is load-bearing (a bare cell
  // click has no located amenity data to highlight).
  const [highlightedTile, setHighlightedTile] = useState<TileHighlightKey | null>(null);

  // LAYOUT-V3 WAVE 3 (2026-08-03, SPEC-layout-v3.md §5.3): whichever
  // getting-around destination (a default anchor or a custom row) is
  // currently hovered/selected -- GettingAroundField owns that interaction
  // state itself and reports just the resolved point up, mirroring
  // highlightedTile/onTileHighlight's own "child owns it, parent relays a
  // value to MapView" shape.
  const [destinationHighlight, setDestinationHighlight] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  function toggleCategory(key: string) {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function addPin(pin: PinnedPlace) {
    // A place pinned twice by the same label just replaces itself -- never
    // a silently-duplicated marker sitting on top of another.
    setPins((prev) => [...prev.filter((p) => p.label !== pin.label), pin]);
  }

  function removePin(label: string) {
    setPins((prev) => prev.filter((p) => p.label !== label));
  }

  // LAYOUT-V3 WAVE 1d item 11: the consolidated search bar's own "pin"
  // button calls this with whatever address is currently typed/selected --
  // the exact same GET /api/geocode call PreferenceBar.tsx's now-removed
  // pin form used to make, just triggered from the one bar instead of two.
  async function pinAddress(address: string) {
    setPinLoading(true);
    setPinError(null);
    try {
      const result = await getGeocode(address);
      addPin({ label: result.label, lat: result.lat, lng: result.lng });
    } catch (e) {
      setPinError(e instanceof ApiError ? e.message : "Something went wrong pinning that place.");
    } finally {
      setPinLoading(false);
    }
  }

  function resetFactcheck() {
    // A new selection invalidates any fact-check results computed against
    // the old one -- leaving them on screen would silently pair the wrong
    // evidence with the wrong claims.
    setFactcheckResult(null);
    setFactcheckError(null);
  }

  async function loadCell(h3: string) {
    setSelectedCell(h3);
    setReportLoading(true);
    setReportError(null);
    resetFactcheck();
    // A new block is loading -- whatever tile the PREVIOUS block's panel
    // had hovered/expanded no longer means anything (CellReportView's own
    // cell-swap effect also clears its own hover/expand state; this clears
    // the map's copy of that same fact so no highlight can survive one
    // frame longer than the report it belonged to).
    setHighlightedTile(null);
    try {
      const report = await getCell(h3);
      setCellReport(report);
      // LAYOUT-V3 WAVE 1 (2026-08-02, SPEC-layout-v3.md §3 "no-scroll-jump
      // requirement"): this used to fire requestAnimationFrame(() =>
      // scrollToId("report")) here -- clicking a cell no longer needs to
      // scroll anywhere, because the side panel beside the map (already on
      // screen) is what updates now, not a stat-card grid below the fold.
    } catch (e) {
      setCellReport(null);
      setReportError(
        e instanceof ApiError ? e.message : "Something went wrong pulling that block's record.",
      );
    } finally {
      setReportLoading(false);
    }
  }

  // The missing click-to-load feature (SPEC-precompute-v2.md Phase 2):
  // clicking any real cell on the citywide grid swaps the report to that
  // location, instantly (GET /api/cell/{h3} is a flat baked-JSON read).
  //
  // UX-AUDIT 2026-08-03 (finding #2, "a bare map-cell click desyncs the
  // search bar from the loaded report"): re-investigated live via Playwright
  // against this exact code (real hit-testing against the actual
  // citywide-cells-fill layer, a real /api/cell/{h3} network call confirmed,
  // both a single click and a rapid real double-click) -- `setAddressInput
  // ("")` below already clears the bar synchronously, in the same tick as
  // `setSearchedAddress(null)`, so a bare cell click always leaves BOTH the
  // heading and the input honestly empty together; the submit button
  // disabling itself is then correct (nothing typed), not a bug. The
  // audit's finding did not reproduce. This is also already the dispatch's
  // own first suggested resolution ("clear... the field") -- kept as the
  // chosen, least-surprising behavior: a cell click gives back a fresh,
  // honestly-empty search bar rather than a stale query that no longer
  // matches what the panel now shows.
  async function handleCellClick(h3: string) {
    setSearchedAddress(null);
    setAddressInput("");
    await loadCell(h3);
  }

  // The fast search path: geocode (a single GeoSearch call, not a live
  // profile compute) -> the containing cell -> the same instant
  // GET /api/cell/{h3} lookup a click uses.
  async function handleSearch(address: string) {
    setAddressInput(address);
    setReportLoading(true);
    setReportError(null);
    resetFactcheck();
    try {
      const geo = await getGeocode(address);
      setSearchedAddress(geo.label);
      setSelectedCell(geo.cell);
      const report = await getCell(geo.cell);
      setCellReport(report);
      // Same no-scroll-jump change as handleCellClick above -- a search
      // result updates the side panel beside the map in place too.
    } catch (e) {
      setCellReport(null);
      setSearchedAddress(null);
      // A failed search resets every other piece of on-screen state tied to
      // the attempted address (report, address band) -- selectedCell was the
      // one exception, leaving the map's red highlight + flown-in camera
      // pointed at whatever the PREVIOUS successful search or click had
      // selected, with nothing on the page left to explain why (2026-07-28
      // UX audit finding #5). Clearing it here matches the reset everything
      // else already gets.
      setSelectedCell(null);
      setReportError(e instanceof ApiError ? e.message : "Something went wrong pulling that record.");
    } finally {
      setReportLoading(false);
    }
  }

  async function submitFactcheck() {
    if (!searchedAddress) return;
    setFactcheckLoading(true);
    setFactcheckError(null);
    try {
      const result = await postFactcheck(searchedAddress, listingText);
      setFactcheckResult(result);
    } catch (e) {
      setFactcheckResult(null);
      setFactcheckError(
        e instanceof ApiError ? e.message : "Something went wrong checking that listing.",
      );
    } finally {
      setFactcheckLoading(false);
    }
  }

  function loadExampleListing() {
    setListingText(EXAMPLE_LISTING_TEXT);
    // Guarantee a genuinely-contradicted result regardless of whatever address is
    // currently loaded -- this button is the "make the demo land" one-click path.
    void handleSearch(EXAMPLE_LISTING_ADDRESS).then(() => scrollToId("factcheck"));
  }

  return (
    <div className="wrap">
      {/* LAYOUT-V3 WAVE 1d items 6/7 (2026-08-03, SPEC-layout-v3.md §8):
          the masthead ("Bearings" + tagline) and the top information band
          labeling the searched address are both gone -- Header.tsx itself
          is deleted, not just unmounted. The app now opens straight at the
          search bar; address identity, when there is one, lives at the
          panel's own compact `.record-line` below (item 2's line), not a
          page-level band duplicating the same fact. */}
      <main>
        {showDisclosure ? (
          <DisclosurePage cell={cellReport} onBack={() => setShowDisclosure(false)} />
        ) : (
          <>
            <AddressSearch
              value={addressInput}
              onChange={setAddressInput}
              onSubmit={handleSearch}
              onPin={pinAddress}
              pinLoading={pinLoading}
              pinError={pinError}
              loading={reportLoading}
              error={reportError}
              compact={cellReport !== null}
            />

            {/* Slim bar above the map (SPEC-lens-report.md §2) -- category
                chips + the pinned-places list, session-only. */}
            <PreferenceBar
              activeCategories={activeCategories}
              onToggleCategory={toggleCategory}
              pins={pins}
              onRemovePin={removePin}
            />

            {/* LAYOUT-V3 WAVE 1d item 2 (2026-08-03, Noah: the "this block"
                identity framing goes -- "the line where it sits becomes the
                plain address/area label itself, no framing word"). Renders
                ONLY when a real address was actually searched: the old
                `?? "This block"` fallback for a bare grid click invented a
                framing label this project has no real area name to back
                (a cell carries no neighbourhood/borough name of its own --
                see types.ts's CellProfile) -- inventing one would fabricate
                an identity the data doesn't have, and the tiles below are
                already the honest record either way. A bare click's side
                panel therefore starts directly at the tile grid, with
                nothing standing in for an address that was never given. */}
            {cellReport && searchedAddress && (
              <div className="record">
                {/* UX-FIX 2026-08-03 (audit finding #7, "search input and
                    report heading show two different renderings of the
                    address at once"): both are still correct and still
                    shown (the input keeps exactly what was typed; this
                    heading keeps the geocoder's own canonical form -- see
                    this file's own item-2 comment above for why that's
                    deliberate) -- this kicker is the missing visual link
                    between them, so two real addresses on screen read as
                    "the same one, confirmed" rather than "which one is
                    right?". `aria-hidden`: the heading's own accessible
                    name must stay exactly the address text (App.test.tsx
                    pins `getByRole("heading", { name: GEOCODE_RESULT.label
                    })`) -- a sighted-only affordance, not new information a
                    screen-reader user is missing (the heading already
                    states the real confirmed address either way). */}
                <p className="record-line__kicker mono" aria-hidden="true">
                  Confirmed as
                </p>
                <h2 className="record-line mono" id="report-heading">
                  {searchedAddress}
                </h2>
              </div>
            )}

            {/* LAYOUT-V3 WAVE 1 (2026-08-02, SPEC-layout-v3.md §3): the
                "answer to what's here" now lives BESIDE the map, not below
                a scroll-jump. .mapgrid is the page-level two-column grid
                (map | side panel); MapView mounts unconditionally inside it
                either way (Task 4/VISUAL.md §5 -- it fetches the citywide
                grid on its own and is interactive before any report has
                ever loaded), while the side panel's own content depends on
                report state: loading, empty (nothing clicked/searched yet),
                or the five real non-transit stat cards from
                CellReportView. */}
            <div className="mapgrid" id="report">
              <MapView
                address={searchedAddress}
                selectedCell={selectedCell}
                onCellClick={handleCellClick}
                activeCategories={activeCategories}
                pins={pins}
                highlightedTile={highlightedTile}
                crimePrecinct={cellReport?.safety.precinct ?? null}
                destinationHighlight={destinationHighlight}
                onOpenDisclosure={() => setShowDisclosure(true)}
              />

              <aside className="sidepanel" aria-label="Block record">
                {reportLoading && !cellReport && (
                  <p className="sidepanel__placeholder mono" role="status">
                    Pulling the record<span className="loading__dots" aria-hidden="true" />
                  </p>
                )}
                {!reportLoading && !cellReport && (
                  <p className="sidepanel__placeholder mono">
                    Click any block for its real record, or search an address for 5, 10, and
                    15-minute walk rings plus nearby places you turn on above.
                  </p>
                )}
                {/* LAYOUT-V3 WAVE 1f item 4 (2026-08-11, SPEC-layout-v3.md
                    §8, "primary" option): Getting Around moves INTO the
                    side panel, below the tiles -- the panel column has
                    always been shorter than the map (Wave 1e dropped it to
                    4 tiles), leaving real unused vertical room at the
                    bottom of this same column; that's its new home, not a
                    separate full-width region below the map any more. See
                    CellReportView.tsx's own GettingAroundField comment for
                    the compact row redesign this required at 360px. */}
                {cellReport && (
                  <>
                    <CellReportView cell={cellReport} onTileHighlight={setHighlightedTile} />
                    <GettingAroundField cell={cellReport} onDestinationHighlight={setDestinationHighlight} />
                  </>
                )}
              </aside>
            </div>

            {cellReport && searchedAddress && (
              <FactCheckView
                address={searchedAddress}
                listingText={listingText}
                onListingTextChange={setListingText}
                onSubmit={submitFactcheck}
                onLoadExample={loadExampleListing}
                loading={factcheckLoading}
                error={factcheckError}
                result={factcheckResult}
              />
            )}
          </>
        )}
      </main>

      <footer className="footer">
        <p>
          Built on public data — every number traces to a source you can click.{" "}
          <button type="button" className="footer__disclosurelink" onClick={() => setShowDisclosure(true)}>
            How this data works
          </button>
        </p>
      </footer>
    </div>
  );
}
