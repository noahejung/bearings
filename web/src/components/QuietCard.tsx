import type { Quiet } from "../types";
import { SourceTag } from "./SourceTag";
import { Stat } from "./Stat";

export function QuietCard({ quiet }: { quiet: Quiet }) {
  return (
    <article className="card card--headline-stat" aria-labelledby="quiet-heading">
      <header className="card__header">
        <span className="card__kicker">Field 04 — Noise</span>
        <h2 className="card__title" id="quiet-heading">
          311 noise complaints
        </h2>
      </header>
      <p className="headline-stat">
        <Stat value={quiet.noise_complaints_12mo} />
      </p>
      <p className="card__footnote">within a 5-minute walk, last 12 months</p>
      <SourceTag source={quiet.source} />
    </article>
  );
}
