import { useState } from "react";
import { ApiError, getProfile, postFactcheck } from "./api";
import { AddressSearch } from "./components/AddressSearch";
import { FactCheckView } from "./components/FactCheckView";
import { Header } from "./components/Header";
import { ReportView } from "./components/ReportView";
import { EXAMPLE_ADDRESSES, EXAMPLE_LISTING_ADDRESS, EXAMPLE_LISTING_TEXT } from "./data/examples";
import type { FactcheckResult, Profile } from "./types";

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

export default function App() {
  const [addressInput, setAddressInput] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [listingText, setListingText] = useState(EXAMPLE_LISTING_TEXT);
  const [factcheckResult, setFactcheckResult] = useState<FactcheckResult | null>(null);
  const [factcheckLoading, setFactcheckLoading] = useState(false);
  const [factcheckError, setFactcheckError] = useState<string | null>(null);

  async function loadAddress(address: string) {
    setAddressInput(address);
    setProfileLoading(true);
    setProfileError(null);
    // A new address invalidates any fact-check results computed against the old one --
    // leaving them on screen would silently pair the wrong evidence with the wrong claims.
    setFactcheckResult(null);
    setFactcheckError(null);

    try {
      const p = await getProfile(address);
      setProfile(p);
      // Defer to the next paint so the report section actually exists before we scroll.
      requestAnimationFrame(() => scrollToId("report"));
    } catch (e) {
      setProfile(null);
      setProfileError(e instanceof ApiError ? e.message : "Something went wrong pulling that record.");
    } finally {
      setProfileLoading(false);
    }
  }

  async function submitFactcheck() {
    if (!profile) return;
    setFactcheckLoading(true);
    setFactcheckError(null);
    try {
      const result = await postFactcheck(profile.address, listingText);
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
    void loadAddress(EXAMPLE_LISTING_ADDRESS).then(() => scrollToId("factcheck"));
  }

  return (
    <div className="wrap">
      <Header cell={profile?.cell} />

      <main>
        <AddressSearch
          value={addressInput}
          onChange={setAddressInput}
          onSubmit={loadAddress}
          examples={EXAMPLE_ADDRESSES}
          loading={profileLoading}
          error={profileError}
          compact={profile !== null}
        />

        {profileLoading && !profile && (
          <p className="loading mono" role="status">
            Pulling the record<span className="loading__dots" aria-hidden="true" />
          </p>
        )}

        {profile && (
          <>
            <ReportView profile={profile} />
            <FactCheckView
              address={profile.address}
              listingText={listingText}
              onListingTextChange={setListingText}
              onSubmit={submitFactcheck}
              onLoadExample={loadExampleListing}
              loading={factcheckLoading}
              error={factcheckError}
              result={factcheckResult}
            />
          </>
        )}
      </main>

      <footer className="footer">
        <p>Built on public data. Every number here traces back to a source you can click.</p>
      </footer>
    </div>
  );
}
