import type { Building } from "../types";
import { SourceTag } from "./SourceTag";
import { Stamp } from "./Stamp";
import { Stat } from "./Stat";

const ERA_LABELS: Record<NonNullable<Building["era"]>, string> = {
  prewar: "Pre-war",
  postwar: "Post-war",
  modern: "Modern",
};

export function BuildingCard({ building }: { building: Building }) {
  // year_built and hpd_open_violations are only ever both null together
  // (bearings/profile.py's _building(): no BBL means no PLUTO lookup *and*
  // no HPD lookup) or both real together -- one guard covers both, but it's
  // written against violations directly so a future profile.py change that
  // breaks that pairing fails a type check here rather than crashing a
  // browser on `null.class_c`.
  const violations = building.hpd_open_violations;
  const hasRecord = building.year_built !== null && violations !== null;

  return (
    <article className="field" aria-labelledby="building-heading">
      <header className="field__head">
        <div>
          <h2 className="field__title" id="building-heading">
            Building age and violations
          </h2>
        </div>
        <Stamp variant={hasRecord ? "confirmed" : "no_data"} compact />
      </header>

      {!hasRecord || violations === null ? (
        <p className="field__empty">We don&rsquo;t have property records for this address yet.</p>
      ) : (
        <>
          <p className="building__note">{building.era_note}</p>
          <p className="building__facts">
            Built <strong>{building.year_built}</strong>
            {building.era && <span className="era">{ERA_LABELS[building.era]}</span>}
          </p>

          <div className="violations">
            <div className="violation">
              <span className="violation__count">
                <Stat value={violations.class_a} />
              </span>
              <span className="violation__label">Minor problems</span>
            </div>
            <div className="violation">
              <span className="violation__count">
                <Stat value={violations.class_b} />
              </span>
              <span className="violation__label">Hazardous problems</span>
            </div>
            <div className={`violation${violations.class_c > 0 ? " violation--flag" : ""}`}>
              <span className="violation__count">
                <Stat value={violations.class_c} />
              </span>
              <span className="violation__label">
                Serious safety problems
                {violations.class_c > 0 && <em> — flagged by the city, not fixed yet</em>}
              </span>
            </div>
          </div>
        </>
      )}
      <p className="field__provenance">
        New York City property and building-safety records, current release · open safety issues
        by severity.
        <br />
        <SourceTag source={building.source} />
      </p>
    </article>
  );
}
