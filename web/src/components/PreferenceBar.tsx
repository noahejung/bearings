import { useId, useState, type FormEvent } from "react";
import { ApiError, getGeocode } from "../api";
import { REACH_CHIPS, type PinnedPlace } from "../lib/preferences";

// The preference bar (SPEC-lens-report.md §2) -- a slim bar above the map.
// Two mechanics, both session-only (no localStorage/URL state anywhere in
// this file, matching lib/preferences.ts's own module docstring):
//   - category chips, toggled on/off, driving MapView's amenity/station dots.
//   - a pin-a-place search, reusing the SAME geocoder (GET /api/geocode)
//     App.tsx's own address search already calls (PLAN-lens-report.md §0:
//     this codebase has no separate venue/business-name search index).
export function PreferenceBar({
  activeCategories,
  onToggleCategory,
  pins,
  onAddPin,
  onRemovePin,
}: {
  activeCategories: Set<string>;
  onToggleCategory: (key: string) => void;
  pins: PinnedPlace[];
  onAddPin: (pin: PinnedPlace) => void;
  onRemovePin: (label: string) => void;
}) {
  const [pinQuery, setPinQuery] = useState("");
  const [pinLoading, setPinLoading] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const inputId = useId();

  async function handlePinSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = pinQuery.trim();
    if (!trimmed) return;
    setPinLoading(true);
    setPinError(null);
    try {
      const result = await getGeocode(trimmed);
      onAddPin({ label: result.label, lat: result.lat, lng: result.lng });
      setPinQuery("");
    } catch (e) {
      setPinError(e instanceof ApiError ? e.message : "Something went wrong pinning that place.");
    } finally {
      setPinLoading(false);
    }
  }

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

      <form className="prefbar__pin" onSubmit={handlePinSubmit}>
        <label className="sr-only" htmlFor={inputId}>
          Pin a place by address
        </label>
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="pin a place — e.g. an address"
          value={pinQuery}
          onChange={(e) => setPinQuery(e.target.value)}
        />
        <button type="submit" className="button button--ghost" disabled={pinLoading || !pinQuery.trim()}>
          {pinLoading ? "pinning…" : "pin it"}
        </button>
      </form>
      {pinError && (
        <p className="prefbar__error" role="alert">
          {pinError}
        </p>
      )}

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
