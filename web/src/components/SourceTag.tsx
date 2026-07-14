import type { Source } from "../types";

// Every number on this site carries one of these -- the fine-print
// provenance line VISUAL.md §4 calls for under every value (dataset +
// link out to it). Per the non-negotiables: a stat without a citation is
// a bug, so this is deliberately the *only* way a source is ever
// rendered -- one component, used everywhere, so there's exactly one
// place to get it right.
export function SourceTag({ source }: { source: Source }) {
  return (
    <a className="provenance-link mono" href={source.url} target="_blank" rel="noopener noreferrer">
      <span className="provenance-link__kicker">SOURCE</span>
      <span className="provenance-link__name">{source.name}</span>
      <span className="provenance-link__arrow" aria-hidden="true">
        →
      </span>
    </a>
  );
}
