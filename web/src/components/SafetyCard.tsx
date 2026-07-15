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
    { label: "Robbery, YTD", ytd: safety.robbery_ytd, pct: safety.robbery_pct },
    { label: "Felony assault, YTD", ytd: safety.felony_assault_ytd, pct: safety.felony_assault_pct },
    { label: "Total major crime, YTD", ytd: safety.total_ytd, pct: safety.total_pct },
  ];

  return (
    <article className="field" aria-labelledby="safety-heading">
      <header className="field__head">
        <div>
          <h2 className="field__title" id="safety-heading">
            {hasData ? `${safety.precinct}${ordinalSuffix(safety.precinct!)} Precinct` : "Precinct crime"}
          </h2>
        </div>
        <Stamp variant={hasData ? "confirmed" : "no_data"} compact />
      </header>

      {!hasData ? (
        <p className="field__empty">No NYPD precinct match for this location.</p>
      ) : (
        <>
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
            NYPD CompStat, week ending {safety.week_ending} · robbery and felony assault only —
            not a comprehensive crime picture, and "total" folds in categories not broken out
            individually.
            <br />
            {safety.source && <SourceTag source={safety.source} />}
          </p>
        </>
      )}
    </article>
  );
}

function ordinalSuffix(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
