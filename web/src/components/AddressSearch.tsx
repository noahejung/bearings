import { useId, type FormEvent } from "react";
import { useAutocomplete } from "../lib/useAutocomplete";
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
//
// LAYOUT-V3 WAVE 3 (2026-08-03, SPEC-layout-v3.md §5.1): the debounce/
// generation-guard/suppression state machine below moved out to
// lib/useAutocomplete.ts, unchanged, so the getting-around region's new
// add-destination field can reuse it instead of building a second
// typeahead. Pure extraction -- every test in AddressSearch.test.tsx is
// unchanged and still green.

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

  const { suggestions, suggestionsOpen, setSuggestionsOpen, suppress: suppressAutocomplete } =
    useAutocomplete(value);

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
