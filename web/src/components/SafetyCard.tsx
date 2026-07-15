import { crimeRelativeLabel, formatPercentile } from "../lib/crime";
import type { Safety } from "../types";
import { SourceTag } from "./SourceTag";
import { Stamp } from "./Stamp";

interface Row {
  label: string;
  ytd: number | undefined;
  pct: number | undefined;
}

// A falling count is encoded as the same ink used for "confirmed" elsewhere in the UI,
// a rising count as the same red used for "contradicted" -- not because rising crime is
// a moral failing being judged, but because trend direction is the one number here that
// benefits from a glance-able encoding (per the brief: "the trend arrow matters more
// than the raw count"). The number itself is always printed too.
function Trend({ pct }: { pct: number | undefined }) {
  if (pct === undefined) return null;
  if (pct === 0) {
    return (
      <span className="trend trend--flat">
        <span aria-hidden="true">→</span> flat
      </span>
    );
  }
  const rising = pct > 0;
  return (
    <span className={`trend ${rising ? "trend--up" : "trend--down"}`}>
      <span aria-hidden="true">{rising ? "▲" : "▼"}</span>
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export function SafetyCard({ safety }: { safety: Safety }) {
  const hasData = typeof safety.precinct === "number";

  const rows: Row[] = [
    { label: "Robbery, so far this year", ytd: safety.robbery_ytd, pct: safety.robbery_pct },
    { label: "Felony assault, so far this year", ytd: safety.felony_assault_ytd, pct: safety.felony_assault_pct },
    { label: "Total major crime, so far this year", ytd: safety.total_ytd, pct: safety.total_pct },
  ];

  return (
    <article className="field" aria-labelledby="safety-heading">
      <header className="field__head">
        <div>
          <h2 className="field__title" id="safety-heading">
            Crime near here
          </h2>
        </div>
        <Stamp variant={hasData ? "confirmed" : "no_data"} compact />
      </header>

      {!hasData ? (
        <p className="field__empty">We don&rsquo;t have crime data for this address yet.</p>
      ) : (
        <>
          {typeof safety.crime_percentile === "number" && (
            <p className="safety-relative">
              <span className="safety-relative__label">
                {crimeRelativeLabel(safety.crime_percentile)}
              </span>
              <span className="safety-relative__detail">
                Ranks {formatPercentile(safety.crime_percentile)} for reported major crime,
                compared with the rest of New York City.
              </span>
            </p>
          )}
          <table className="safety-table">
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className="safety-table__ytd">{r.ytd ?? "—"}</td>
                  <td className="safety-table__trend">
                    <Trend pct={r.pct} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field__provenance">
            NYPD crime data, week ending {safety.week_ending} · robbery and felony assault only —
            not a full picture of crime, and the "total" also includes other crime categories not
            listed separately here.
            {safety.crime_caveat && (
              <>
                <br />
                {safety.crime_caveat}
              </>
            )}
            <br />
            {safety.source && <SourceTag source={safety.source} />}
          </p>
        </>
      )}
    </article>
  );
}
