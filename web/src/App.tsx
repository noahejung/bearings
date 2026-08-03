import { useState } from "react";
import { ApiError, getCell, getGeocode, postFactcheck } from "./api";
import { AddressSearch } from "./components/AddressSearch";
import { CellReportView, GettingAroundField, type TileHighlightKey } from "./components/CellReportView";
import { FactCheckView } from "./components/FactCheckView";
import { Header } from "./components/Header";
import { MapView } from "./components/MapView";
import { PreferenceBar } from "./components/PreferenceBar";
import { EXAMPLE_ADDRESSES, EXAMPLE_LISTING_ADDRESS, EXAMPLE_LISTING_TEXT } from "./data/examples";
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

  // LAYOUT-V3 WAVE 1c item 4: which side-panel tile (if any) the map should
  // currently emphasize -- CellReportView owns the hover/expand logic
  // itself and reports just this one key up via onTileHighlight; MapView
  // reads it (plus its own reach/citywide/selectedCell state) to decide
  // what real geometry, if any, to draw. See MapView.tsx's own
  // tileHighlightGeometry() for why "if any" is load-bearing (a bare cell
  // click has no located amenity data to highlight).
  const [highlightedTile, setHighlightedTile] = useState<TileHighlightKey | null>(null);

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
      <Header address={searchedAddress} />

      <main>
        <AddressSearch
          value={addressInput}
          onChange={setAddressInput}
          onSubmit={handleSearch}
          examples={EXAMPLE_ADDRESSES}
          loading={reportLoading}
          error={reportError}
          compact={cellReport !== null}
        />

        {/* Slim bar above the map (SPEC-lens-report.md §2) -- category
            chips + pin search, both session-only. */}
        <PreferenceBar
          activeCategories={activeCategories}
          onToggleCategory={toggleCategory}
          pins={pins}
          onAddPin={addPin}
          onRemovePin={removePin}
        />

        {/* LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item
            2, Noah: the old kicker+title block here "appears for no clear
            reason" -- replaced with ONE compact line, not a title ceremony
            (no separate "The record" kicker paragraph, no big display-font
            headline). Kept ABOVE `.mapgrid` rather than moved inside
            `.sidepanel` deliberately: item 1 (this same wave) requires the
            side panel's first TILE to top-align with the map canvas, and
            putting this line inside `.sidepanel` would push the tiles down
            by its own height with nothing matching on the map side to
            compensate -- see MapView.tsx's own item-1 comment. */}
        {cellReport && (
          <h2 className="record-line mono" id="report-heading">
            {searchedAddress ?? "This block"}
          </h2>
        )}

        {/* LAYOUT-V3 WAVE 1 (2026-08-02, SPEC-layout-v3.md §3): the "answer
            to what's here" now lives BESIDE the map, not below a scroll-
            jump. .mapgrid is the page-level two-column grid (map | side
            panel); MapView mounts unconditionally inside it either way
            (Task 4/VISUAL.md §5 -- it fetches the citywide grid on its own
            and is interactive before any report has ever loaded), while
            the side panel's own content depends on report state: loading,
            empty (nothing clicked/searched yet), or the five real
            non-transit stat cards from CellReportView. */}
        <div className="mapgrid" id="report">
          <MapView
            address={searchedAddress}
            selectedCell={selectedCell}
            onCellClick={handleCellClick}
            activeCategories={activeCategories}
            pins={pins}
            highlightedTile={highlightedTile}
            crimePrecinct={cellReport?.safety.precinct ?? null}
          />

          <aside className="sidepanel" aria-label="This block's record">
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
            {cellReport && <CellReportView cell={cellReport} onTileHighlight={setHighlightedTile} />}
          </aside>
        </div>

        {cellReport && (
          <>
            <GettingAroundField cell={cellReport} />

            {searchedAddress && (
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
        <p>Built on public data — every number traces to a source you can click.</p>
      </footer>
    </div>
  );
}
