import type { Green } from "../types";
import { SourceTag } from "./SourceTag";
import { Stamp } from "./Stamp";
import { Stat } from "./Stat";

export function GreenCard({ green }: { green: Green }) {
  const hasData = green.street_trees_nearby !== null;
  return (
    <article className="field" aria-labelledby="green-heading">
      <header className="field__head">
        <div>
          <h2 className="field__title" id="green-heading">
            Living street trees
          </h2>
        </div>
        <Stamp variant={hasData ? "confirmed" : "no_data"} compact />
      </header>
      <p className="headline">
        <Stat value={green.street_trees_nearby} />
      </p>
      <p className="field__provenance">
        From the city's last official street-tree count, in 2015 · within a 5-minute walk
        (400m radius). Trees planted since then won't show up here.
        <br />
        <SourceTag source={green.source} />
      </p>
    </article>
  );
}
