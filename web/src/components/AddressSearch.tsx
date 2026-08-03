import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { getAutocomplete } from "../api";
import type { AutocompleteResult } from "../types";

// LAYOUT-V3 WAVE 1d items 5 + 11 (2026-08-03, SPEC-layout-v3.md §8): the
// "or try —" example chips are gone outright (item 5 -- a real cut, not
// relocated; EXAMPLE_ADDRESSES itself stays in data/examples.ts because
// FactCheckView's "see a worked example" button still needs
// EXAMPLE_LISTING_ADDRESS/EXAMPLE_LISTING_TEXT). The old split search-bar
// (this file) / pin-search-bar (PreferenceBar.tsx) flow is replaced with
// ONE bar: this input now also drives a debounced typeahead (real GeoSearch
// candidates, GET /api/geocode/autocomplete) and carries its own "pin"
// button beside "Pull the record" -- picking a suggestion or submitting the
// form loads it as the main record; the pin button pins whatever address is
// currently typed/selected instead, reusing the exact geocode this bar
// already ran to show suggestions rather than a second round-trip.
const AUTOCOMPLETE_MIN_CHARS = 3;
const AUTOCOMPLETE_DEBOUNCE_MS = 300;

interface AddressSearchProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (address: string) => void;
  /** Pins the given address (adds a badge on the map) rather than loading it as the main record. */
  onPin: (address: string) => void;
  pinLoading: boolean;
  pinError: string | null;
  loading: boolean;
  error: string | null;
  /** true once a profile has already loaded -- renders the slim compact bar instead of the hero. */
  compact: boolean;
}

export function AddressSearch({
  value,
  onChange,
  onSubmit,
  onPin,
  pinLoading,
  pinError,
  loading,
  error,
  compact,
}: AddressSearchProps) {
  const inputId = useId();
  const errorId = useId();
  const pinErrorId = useId();

  const [suggestions, setSuggestions] = useState<AutocompleteResult[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // Generation counter, not `AbortController` -- api.ts's `request()` has
  // no signal support to plug one into, and this repo's own established
  // pattern for "ignore a fetch that resolved after a newer one started"
  // (every effect in MapView.tsx) is a plain guard variable, not a browser
  // abort primitive. Only the LATEST keystroke's response is ever applied.
  const requestGenRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The value a submit/pick/pin action just consumed -- a real, live-caught
  // bug this guards against: picking a suggestion (or submitting the typed
  // text) changes `value` itself (via `onChange`/App.tsx's own address-input
  // state), which re-triggers this effect and schedules a BRAND NEW
  // autocomplete fetch for that now-complete address -- one that almost
  // always matches, reopening the dropdown right after the user just picked
  // or submitted it. Skipping a fetch when `value` exactly equals the last
  // submitted value (not just invalidating an in-flight one, which
  // `suppressAutocomplete()` below also does for the race-condition variant)
  // closes both paths.
  const lastSubmittedRef = useRef<string | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = value.trim();
    if (trimmed.length < AUTOCOMPLETE_MIN_CHARS || trimmed === lastSubmittedRef.current) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    const gen = ++requestGenRef.current;
    debounceRef.current = setTimeout(() => {
      getAutocomplete(trimmed)
        .then((res) => {
          if (gen !== requestGenRef.current) return; // a newer keystroke already superseded this
          setSuggestions(res.results);
          setSuggestionsOpen(res.results.length > 0);
        })
        .catch(() => {
          // Non-fatal: a typeahead that can't reach the API just shows no
          // suggestions -- the form still works as a plain address search.
          if (gen !== requestGenRef.current) return;
          setSuggestions([]);
          setSuggestionsOpen(false);
        });
    }, AUTOCOMPLETE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  // Cancels whatever autocomplete request is pending (scheduled OR already
  // in flight) and closes the dropdown -- a real, live-caught bug this
  // guards against: submitting the form while a debounced fetch was still
  // in flight closed the dropdown at that instant, but the fetch's own
  // `.then()` still resolved afterward and reopened it (nothing had
  // invalidated its generation number, since `value` itself hadn't
  // changed). Bumping the generation here makes that stale response a
  // no-op regardless of when it resolves.
  function suppressAutocomplete(consumedValue: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestGenRef.current++;
    lastSubmittedRef.current = consumedValue;
    setSuggestionsOpen(false);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    suppressAutocomplete(trimmed);
  }

  function pickSuggestion(s: AutocompleteResult) {
    suppressAutocomplete(s.label.trim());
    onChange(s.label);
    onSubmit(s.label);
  }

  function handlePinClick() {
    const trimmed = value.trim();
    if (trimmed) onPin(trimmed);
    suppressAutocomplete(trimmed);
  }

  return (
    <section className={`search${compact ? " search--compact" : ""}`}>
      {!compact && (
        <div className="search__intro">
          <h2 className="search__headline">
            See what <em>public records</em> say about daily life at an address.
          </h2>
          <p className="search__sub">
            Real train times, not distance to the platform. Noise complaints, tree counts,
            nearby crime, and a building's safety record — every number sourced, none of it
            opinion.
          </p>
        </div>
      )}

      <form className="search__form" onSubmit={handleSubmit} role="search">
        <label className="sr-only" htmlFor={inputId}>
          NYC address
        </label>
        <div className="search__field">
          <input
            id={inputId}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="350 5TH AVE, MANHATTAN"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setSuggestionsOpen(suggestions.length > 0)}
            onBlur={() => {
              // A short delay, not an instant close -- otherwise blur fires
              // before a suggestion's own onClick can register, and a
              // click-to-pick would silently do nothing (the classic
              // dropdown-closes-before-click bug).
              window.setTimeout(() => setSuggestionsOpen(false), 150);
            }}
            role="combobox"
            aria-expanded={suggestionsOpen}
            aria-controls={`${inputId}-suggestions`}
            aria-autocomplete="list"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <button type="submit" disabled={loading || value.trim().length === 0}>
            {loading ? "Pulling…" : "Pull the record"}
          </button>
          <button
            type="button"
            className="search__pin"
            onClick={handlePinClick}
            disabled={pinLoading || value.trim().length === 0}
            aria-describedby={pinError ? pinErrorId : undefined}
          >
            {pinLoading ? "pinning…" : "pin it"}
          </button>
        </div>

        {suggestionsOpen && (
          <ul className="search__suggestions" id={`${inputId}-suggestions`} role="listbox">
            {suggestions.map((s) => (
              <li key={`${s.label}-${s.lat}-${s.lng}`}>
                <button
                  type="button"
                  className="search__suggestion"
                  role="option"
                  aria-selected={false}
                  // onMouseDown (not onClick) fires before the input's own
                  // onBlur, so a suggestion can be picked without the blur
                  // timeout racing it -- belt-and-suspenders with the delay
                  // above, not a substitute for it (keyboard/touch users
                  // still rely on the delay).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSuggestion(s)}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>

      {error && (
        <p className="search__error" role="alert" id={errorId}>
          {error}
        </p>
      )}
      {pinError && (
        <p className="search__error" role="alert" id={pinErrorId}>
          {pinError}
        </p>
      )}
    </section>
  );
}
