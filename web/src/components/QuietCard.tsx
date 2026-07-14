import type { Quiet } from "../types";
import { SourceTag } from "./SourceTag";
import { Stamp } from "./Stamp";
import { Stat } from "./Stat";

export function QuietCard({ quiet }: { quiet: Quiet }) {
  const hasData = quiet.noise_complaints_12mo !== null;
  return (
    <article className="field" aria-labelledby="quiet-heading">
      <header className="field__head">
        <div>
          <span className="field__code">§04·QUI</span>
          <h2 className="field__title" id="quiet-heading">
            311 noise complaints
          </h2>
        </div>
        <Stamp variant={hasData ? "confirmed" : "no_data"} compact />
      </header>
      <p className="headline">
        <Stat value={quiet.noise_complaints_12mo} />
      </p>
      <p className="field__provenance">
        NYC 311, trailing 12 months · within a 5-minute walk (400m radius).
        <br />
        <SourceTag source={quiet.source} />
      </p>
    </article>
  );
}
