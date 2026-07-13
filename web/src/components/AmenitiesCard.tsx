import type { Amenities, AmenityCounts } from "../types";
import { SourceTag } from "./SourceTag";
import { Stat } from "./Stat";

// Fixed display order -- deliberately not sorted by count, so the grid doesn't reshuffle
// address to address (that would make it harder to compare two profiles at a glance,
// which is exactly the kind of thing this whole tool exists to make comparable).
const CATEGORY_LABELS: [keyof AmenityCounts, string][] = [
  ["grocery", "Grocery"],
  ["cafe", "Cafe"],
  ["restaurant", "Restaurant"],
  ["bar", "Bar"],
  ["pharmacy", "Pharmacy"],
  ["gym", "Gym"],
  ["park", "Park"],
  ["laundry", "Laundry"],
];

export function AmenitiesCard({ amenities }: { amenities: Amenities }) {
  return (
    <article className="card card--amenities" aria-labelledby="amenities-heading">
      <header className="card__header">
        <span className="card__kicker">Field 02 — Amenities</span>
        <h2 className="card__title" id="amenities-heading">
          Within a 10-minute walk
        </h2>
      </header>
      <ul className="amenity-grid">
        {CATEGORY_LABELS.map(([key, label]) => (
          <li className="amenity-grid__tile" key={key}>
            <span className="amenity-grid__count">
              <Stat value={amenities.counts[key]} />
            </span>
            <span className="amenity-grid__label">{label}</span>
          </li>
        ))}
      </ul>
      <p className="card__footnote">
        Counted within the address's H3 cell and its immediate neighbours — a hex disk, not
        the real walkable street network, so it can over- or under-count near rivers,
        parks, or highways.
      </p>
      <SourceTag source={amenities.source} />
    </article>
  );
}
