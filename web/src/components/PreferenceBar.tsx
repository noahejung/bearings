import { REACH_CHIPS, type PinnedPlace } from "../lib/preferences";

// The preference bar (SPEC-lens-report.md §2) -- a slim bar above the map.
// Category chips, toggled on/off, driving MapView's amenity/station dots,
// plus the pinned-places list.
//
// LAYOUT-V3 WAVE 1d item 11 (2026-08-03, SPEC-layout-v3.md §8, Noah: "a
// save/pin button next to the [search] bar... replaces the split search-
// vs-pin flow"): this file's own separate pin-a-place text input + "pin it"
// button (a second geocoder entry point, duplicating AddressSearch.tsx's
// own bar) is gone -- pinning now happens from the single consolidated
// search bar (AddressSearch.tsx), which App.tsx wires straight to the same
// `addPin`/`pins` state this component already read. This component keeps
// only what's still genuinely its own: the category chips and the pinned-
// places list/remove control, neither of which duplicates anything else on
// the page.
export function PreferenceBar({
  activeCategories,
  onToggleCategory,
  pins,
  onRemovePin,
}: {
  activeCategories: Set<string>;
  onToggleCategory: (key: string) => void;
  pins: PinnedPlace[];
  onRemovePin: (label: string) => void;
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

      {pins.length > 0 && (
        <ul className="prefbar__pins" aria-label="Pinned places">
          {pins.map((pin) => (
            <li key={pin.label} className="prefbar__pinitem">
              <span>{pin.label}</span>
              <button
                type="button"
                className="prefbar__pinremove"
                aria-label={`Remove pin: ${pin.label}`}
                onClick={() => onRemovePin(pin.label)}
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
