import { useState } from "react";
import { ApiError, getCell, getGeocode, postFactcheck } from "./api";
import { AddressSearch } from "./components/AddressSearch";
import { CellReportView } from "./components/CellReportView";
import { FactCheckView } from "./components/FactCheckView";
import { Header } from "./components/Header";
import { MapView } from "./components/MapView";
import { EXAMPLE_ADDRESSES, EXAMPLE_LISTING_ADDRESS, EXAMPLE_LISTING_TEXT } from "./data/examples";
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
    try {
      const report = await getCell(h3);
      setCellReport(report);
      // Defer to the next paint so the report section actually exists before we scroll.
      requestAnimationFrame(() => scrollToId("report"));
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
      requestAnimationFrame(() => scrollToId("report"));
    } catch (e) {
      setCellReport(null);
      setSearchedAddress(null);
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

        {/* The map mounts immediately, independent of any search or click
            (Task 4/VISUAL.md §5) -- it fetches the citywide grid on its
            own and is interactive before any report has ever loaded. */}
        <MapView address={searchedAddress} selectedCell={selectedCell} onCellClick={handleCellClick} />

        {reportLoading && !cellReport && (
          <p className="loading mono" role="status">
            Pulling the record<span className="loading__dots" aria-hidden="true" />
          </p>
        )}

        {cellReport && (
          <>
            <section className="report" id="report" aria-labelledby="report-heading">
              <header className="report__head">
                <p className="report__kicker mono">The record</p>
                <h2 className="report__title" id="report-heading">
                  {searchedAddress ?? "This block"}
                </h2>
              </header>
              <CellReportView cell={cellReport} />
            </section>

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
        <p>Built on public data. Every number here traces back to a source you can click.</p>
      </footer>
    </div>
  );
}
