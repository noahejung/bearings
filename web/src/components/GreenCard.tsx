import type { Green } from "../types";
import { SourceTag } from "./SourceTag";
import { Stat } from "./Stat";

export function GreenCard({ green }: { green: Green }) {
  return (
    <article className="card card--headline-stat" aria-labelledby="green-heading">
      <header className="card__header">
        <span className="card__kicker">Field 05 — Street trees</span>
        <h2 className="card__title" id="green-heading">
          Living street trees
        </h2>
      </header>
      <p className="headline-stat">
        <Stat value={green.street_trees_nearby} />
      </p>
      <p className="card__footnote">within a 5-minute walk</p>
      <SourceTag source={green.source} />
    </article>
  );
}
