import { useId, type FormEvent } from "react";
import { useAutocomplete } from "../lib/useAutocomplete";
import type { SavedPlace } from "../lib/preferences";
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
//
// WAVE 6f item 8 (2026-08-11, Noah: "instead of pin can we just click
// save"): the button named "pin"/"pin it" throughout the two paragraphs
// above is now labelled + named "save" everywhere in this file (onSave,
// handleSaveClick, .search__save) -- the underlying feature (add a badge
// to the map without loading it as the main record) is unchanged, only the
// word. It's also no longer session-only: saved places persist via
// localStorage now (App.tsx's own effect, lib/preferences.ts) and surface
// as a minimal quick-pick list right in this bar's own dropdown when the
// field is empty (see showSaved's own comment below).
//
// LAYOUT-V3 WAVE 6 (2026-08-11, SPEC-layout-v3.md §8): this bar is now the
// app's one persistent shell anchor (App.tsx mounts it unconditionally,
// above the map/disclosure split) -- the former `compact` prop and its
// hero-mode sibling (`.search__intro`: headline + sub-copy, shown only
// pre-first-report) are gone. A shell whose own anchor element resizes
// between "hero" and "slim" as soon as a report loads is exactly the kind
// of chrome drift this wave exists to remove -- the bar now always renders
// at its one slim size, in every view, so its bounding box never changes.
// The hero copy itself is not reworded or relocated -- it named no fact
// the slim bar's placeholder text doesn't already convey ("NYC address" via
// its label, "350 5TH AVE, MANHATTAN" via its placeholder), so it is cut
// outright, the same "does removing this make the next user action harder"
// test Wave 1d item 2 already applied to decorative headers.

interface AddressSearchProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (address: string) => void;
  /** Saves the given address (adds a badge on the map) rather than loading
   * it as the main record. Renamed from `onPin` in WAVE 6f item 8
   * (2026-08-11, Noah: "instead of pin can we just click save"). */
  onSave: (address: string) => void;
  /** WAVE 6b (2026-08-11, SPEC-layout-v3.md §8): empties the field AND
   * whatever selection/report it currently reflects -- see App.tsx's own
   * `clearSelection` for what "coherently" resets alongside the text. */
  onClear: () => void;
  saveLoading: boolean;
  saveError: string | null;
  loading: boolean;
  error: string | null;
  /** WAVE 6f item 7 (2026-08-11, Noah: "a bare click cell shows nothing.
   * we only see 350 5th ave manhattan every time"). A real reverse-geocode
   * hint for whichever cell was just bare-clicked (App.tsx's own
   * approxAddress state) -- null the rest of the time (nothing clicked
   * yet, or a real address is loaded/typed instead). Swaps the field's own
   * placeholder to name the actual clicked block instead of the old fixed
   * "350 5TH AVE, MANHATTAN" example, which is exactly the string Noah's
   * complaint named -- a placeholder that happens to look like a plausible
   * real address reads as a stuck value on an honestly-empty field. */
  approxAddress: string | null;
  /** WAVE 6f item 8 (2026-08-11, Noah: "instead of pin can we just click
   * save"): the persisted saved-places list (App.tsx owns load/save via
   * lib/preferences.ts) -- surfaced here as a minimal quick-pick list in
   * this bar's own dropdown when the field is empty, so a saved place is
   * reachable from the one search entry point instead of only the sidebar
   * list below the map. */
  saved: SavedPlace[];
  /** Removes one saved place -- the dropdown's own minimal unsave
   * affordance, mirroring PreferenceBar's sidebar list (same underlying
   * `removeSaved` in App.tsx, just reachable from a second place). */
  onUnsave: (label: string) => void;
}

export function AddressSearch({
  value,
  onChange,
  onSubmit,
  onSave,
  onClear,
  saveLoading,
  saveError,
  loading,
  error,
  approxAddress,
  saved,
  onUnsave,
}: AddressSearchProps) {
  const inputId = useId();
  const errorId = useId();
  const saveErrorId = useId();

  // WAVE 6f item 7's other half: the RESTING placeholder (no cell clicked
  // yet) used to be a fixed real-looking example ("350 5TH AVE,
  // MANHATTAN") -- indistinguishable at a glance from a real typed value,
  // which is the literal shape of Noah's complaint ("we only see 350 5th
  // ave manhattan every time"). It's now an instruction, not an example --
  // no house number/street/borough token that could be mistaken for a
  // resolved address. `approxAddress` overrides it with a real, freshly
  // reverse-geocoded hint the moment one exists.
  const placeholder = approxAddress ? `≈ ${approxAddress}` : "SEARCH AN NYC ADDRESS…";

  const { suggestions, suggestionsOpen, setSuggestionsOpen, suppress: suppressAutocomplete } =
    useAutocomplete(value);

  // WAVE 6f item 8 (2026-08-11, Noah: "instead of pin can we just click
  // save"): the dropdown shows saved places INSTEAD of live typeahead
  // results only when the field is empty (an empty query never has live
  // suggestions anyway -- useAutocomplete's own >= 3 char gate -- so this
  // never hides a real GeoSearch candidate). "Minimal": no extra chrome
  // beyond what the live-suggestions list already has, just a different
  // source list.
  const showSaved = value.trim().length === 0 && saved.length > 0;

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

  function pickSaved(place: SavedPlace) {
    suppressAutocomplete(place.label.trim());
    onChange(place.label);
    onSubmit(place.label);
  }

  function handleSaveClick() {
    const trimmed = value.trim();
    if (trimmed) onSave(trimmed);
    suppressAutocomplete(trimmed);
  }

  return (
    <section className="search">
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
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setSuggestionsOpen(showSaved || suggestions.length > 0)}
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
          {/* WAVE 6b (2026-08-11, SPEC-layout-v3.md §8): a clear-X, shown only
              once there's real text to clear -- clicking it resets the field
              AND whatever selection/report it currently reflects (App.tsx's
              clearSelection), never just the input alone (a text-only clear
              would leave the map/panel pointed at an address the field no
              longer names, reopening the exact desync this wave closes). */}
          {value.length > 0 && (
            <button
              type="button"
              className="search__clear"
              aria-label="Clear search"
              onClick={() => {
                onClear();
                suppressAutocomplete("");
              }}
            >
              ×
            </button>
          )}
          <button type="submit" disabled={loading || value.trim().length === 0}>
            {loading ? "Pulling…" : "Pull the record"}
          </button>
          <button
            type="button"
            className="search__save"
            onClick={handleSaveClick}
            disabled={saveLoading || value.trim().length === 0}
            aria-describedby={saveError ? saveErrorId : undefined}
          >
            {saveLoading ? "saving…" : "save"}
          </button>
        </div>

        {suggestionsOpen && (
          <ul className="search__suggestions" id={`${inputId}-suggestions`} role="listbox">
            {showSaved
              ? // WAVE 6f item 8: the empty-field state shows saved places
                // instead of live autocomplete (see showSaved's own comment
                // above) -- each row picks it the same way a live suggestion
                // does (fills + submits), plus a minimal unsave "×" so this
                // list doesn't require a trip to the sidebar just to remove
                // one.
                saved.map((place) => (
                  <li key={place.label} className="search__suggestion--saved">
                    <button
                      type="button"
                      className="search__suggestion"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSaved(place)}
                    >
                      {place.label}
                    </button>
                    <button
                      type="button"
                      className="search__suggestion-unsave"
                      aria-label={`Unsave ${place.label}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onUnsave(place.label)}
                    >
                      ×
                    </button>
                  </li>
                ))
              : suggestions.map((s) => (
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
      {saveError && (
        <p className="search__error" role="alert" id={saveErrorId}>
          {saveError}
        </p>
      )}
    </section>
  );
}
