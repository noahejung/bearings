import type { Transit } from "../types";
import { RouteBullets } from "./RouteBullet";
import { SourceTag } from "./SourceTag";
import { Stamp } from "./Stamp";

const ANCHOR_LABELS: Record<keyof Transit["to_anchors"], string> = {
  midtown: "Midtown",
  wtc: "World Trade Center",
  downtown_brooklyn: "Downtown Brooklyn",
  newport_path: "Newport, NJ (PATH)",
};

// A generous ceiling for the bar scale rather than the max of the four values --
// otherwise a Staten Island profile where every anchor is unreachable (see below) would
// have nothing to scale the bars against, and a Midtown profile where every anchor is
// close would make small real differences look identical.
const BAR_SCALE_MAX_MIN = 60;

export function TransitCard({ transit }: { transit: Transit }) {
  const anchorEntries = Object.entries(transit.to_anchors) as [
    keyof Transit["to_anchors"],
    number,
  ][];

  return (
    <article className="field field--wide" aria-labelledby="transit-heading">
      <header className="field__head">
        <div>
          <h2 className="field__title" id="transit-heading">
            Getting around
          </h2>
        </div>
        <Stamp variant={transit.nearest_stations.length > 0 ? "confirmed" : "no_data"} compact />
      </header>

      {transit.nearest_stations.length === 0 ? (
        <p className="field__empty">No subway or PATH station within a 20-minute walk.</p>
      ) : (
        <ul className="stations">
          {transit.nearest_stations.map((s, i) => (
            // No stable per-station ID crosses the API boundary (the contract exposes
            // name/routes/walk_minutes only -- see types.ts), and two entries here can
            // legitimately share a name (e.g. the "34 St-Herald Sq" B/D/F/M and N/Q/R/W
            // platforms are separate stations with the same walk time). The list order
            // is server-determined and never reordered client-side, so the index is a
            // safe key here.
            <li className="station" key={i}>
              <RouteBullets routes={s.routes} />
              <span className="station__name">{s.name}</span>
              <span className="station__walk mono">{s.walk_minutes} min walk</span>
            </li>
          ))}
        </ul>
      )}

      <div className="anchors">
        <p className="anchors__label">Ride time to —</p>
        {anchorEntries.map(([key, minutes]) => {
          const reachable = minutes >= 0;
          const pct = reachable ? Math.min(100, (minutes / BAR_SCALE_MAX_MIN) * 100) : 0;
          return (
            <div className="anchor" key={key}>
              <span className="anchor__label">{ANCHOR_LABELS[key]}</span>
              <span className="anchor__track">
                {reachable ? <span className="anchor__fill" style={{ width: `${pct}%` }} /> : null}
              </span>
              <span
                className={`anchor__value${reachable ? "" : " anchor__value--nodata"}`}
              >
                {reachable ? `${minutes} min` : "no route found"}
              </span>
            </div>
          );
        })}
      </div>

      <p className="field__caveat mono">
        <span className="field__caveat-kicker" aria-hidden="true">
          note
        </span>
        {transit.caveat}
      </p>
      <p className="field__provenance">
        MTA GTFS + PATH GTFS · median weekday 08:00 departure · one-to-all Dijkstra from four
        fixed anchors.
        <br />
        <SourceTag source={transit.source} />
      </p>
    </article>
  );
}
