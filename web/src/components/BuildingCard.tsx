import type { Building } from "../types";
import { SourceTag } from "./SourceTag";
import { Stat } from "./Stat";

const ERA_LABELS: Record<NonNullable<Building["era"]>, string> = {
  prewar: "Pre-war",
  postwar: "Post-war",
  modern: "Modern",
};

export function BuildingCard({ building }: { building: Building }) {
  const hasRecord = building.year_built !== null;
  const violations = building.hpd_open_violations;
  const classCFlag = violations.class_c > 0;

  return (
    <article className="card card--building" aria-labelledby="building-heading">
      <header className="card__header">
        <span className="card__kicker">Field 06 — Building age</span>
        <h2 className="card__title" id="building-heading">
          What could exist here
        </h2>
      </header>

      {!hasRecord ? (
        <p className="card__empty">No PLUTO record for this lot.</p>
      ) : (
        <>
          <p className="building-era-note">{building.era_note}</p>
          <p className="building-facts">
            Built <strong>{building.year_built}</strong>
            {building.era && (
              <span className={`era-badge era-badge--${building.era}`}>
                {ERA_LABELS[building.era]}
              </span>
            )}
          </p>
        </>
      )}

      <div className="violations-row">
        <div className="violations-row__tile">
          <span className="violations-row__count">
            <Stat value={violations.class_a} />
          </span>
          <span className="violations-row__label">Class A</span>
        </div>
        <div className="violations-row__tile">
          <span className="violations-row__count">
            <Stat value={violations.class_b} />
          </span>
          <span className="violations-row__label">Class B</span>
        </div>
        <div className={`violations-row__tile${classCFlag ? " violations-row__tile--flag" : ""}`}>
          <span className="violations-row__count">
            <Stat value={violations.class_c} />
          </span>
          <span className="violations-row__label">
            Class C{classCFlag && <em> — immediately hazardous</em>}
          </span>
        </div>
      </div>
      <p className="card__footnote">Open HPD housing-code violations, by class.</p>
      <SourceTag source={building.source} />
    </article>
  );
}
