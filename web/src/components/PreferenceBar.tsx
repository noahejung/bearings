import { REACH_CHIPS, type SavedPlace } from "../lib/preferences";

// The preference bar (SPEC-lens-report.md §2) -- a slim bar above the map.
// Category chips, toggled on/off, driving MapView's amenity/station dots,
// plus the saved-places list.
//
// LAYOUT-V3 WAVE 1d item 11 (2026-08-03, SPEC-layout-v3.md §8, Noah: "a
// save/pin button next to the [search] bar... replaces the split search-
// vs-pin flow"): this file's own separate pin-a-place text input + "pin it"
// button (a second geocoder entry point, duplicating AddressSearch.tsx's
// own bar) is gone -- saving now happens from the single consolidated
// search bar (AddressSearch.tsx), which App.tsx wires straight to the same
// `addSaved`/`saved` state this component already read. This component
// keeps only what's still genuinely its own: the category chips and the
// saved-places list/remove control, neither of which duplicates anything
// else on the page.
//
// WAVE 6f item 8 (2026-08-11, Noah: "instead of pin can we just click
// save"): renamed throughout (`pins`->`saved`, `onRemovePin`->`onUnsave`) --
// the underlying feature (and this component's own props/behavior) is
// otherwise unchanged; the list itself now also persists via localStorage
// (App.tsx's own effect, lib/preferences.ts), invisible from this
// component's own perspective, which still just renders whatever list it's
// handed.
export function PreferenceBar({
  activeCategories,
  onToggleCategory,
  saved,
  onUnsave,
}: {
  activeCategories: Set<string>;
  onToggleCategory: (key: string) => void;
  saved: SavedPlace[];
  onUnsave: (label: string) => void;
}) {
  return (
    <section className="prefbar" aria-label="Map preferences">
      <div className="prefbar__chips" role="group" aria-label="Show nearby places by category">
        {REACH_CHIPS.map((chip) => {
          const pressed = activeCategories.has(chip.key);
          return (
            <button
              key={chip.key}
              type="button"
              className="prefbar__chip"
              aria-pressed={pressed}
              onClick={() => onToggleCategory(chip.key)}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {saved.length > 0 && (
        <ul className="prefbar__saved" aria-label="Saved places">
          {saved.map((place) => (
            <li key={place.label} className="prefbar__saveditem">
              <span>{place.label}</span>
              <button
                type="button"
                className="prefbar__savedremove"
                aria-label={`Unsave ${place.label}`}
                onClick={() => onUnsave(place.label)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
