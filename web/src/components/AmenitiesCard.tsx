import type { Amenities, AmenityCounts } from "../types";
import { SourceTag } from "./SourceTag";
import { Stamp } from "./Stamp";
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
    <article className="field" aria-labelledby="amenities-heading">
      <header className="field__head">
        <div>
          <h2 className="field__title" id="amenities-heading">
            Within a 10-minute walk
          </h2>
        </div>
        {/* Every bucket is a real, queried int (never a missing key -- api.py's own
            _to_contract() fills every category to a real zero), so this field is
            always confirmed, unlike fields where a null is genuinely possible. */}
        <Stamp variant="confirmed" compact />
      </header>
      <ul className="amenities">
        {CATEGORY_LABELS.map(([key, label]) => (
          <li className="amenity" key={key}>
            <span className="amenity__count">
              <Stat value={amenities.counts[key]} />
            </span>
            <span className="amenity__label">{label}</span>
          </li>
        ))}
      </ul>
      <p className="field__provenance">
        Overture Maps Places, current release · counted in this block and the blocks right
        around it, as the crow flies rather than actual walking routes — can over- or
        under-count near rivers, parks, or highways.
        <br />
        <SourceTag source={amenities.source} />
      </p>
    </article>
  );
}
