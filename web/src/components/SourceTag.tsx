import type { Source } from "../types";

// Every number on this site carries one of these. Per the non-negotiables: a stat
// without a citation is a bug, so this is deliberately the *only* way a source is ever
// rendered -- one component, used everywhere, so there's exactly one place to get right.
export function SourceTag({ source }: { source: Source }) {
  return (
    <a
      className="source-tag"
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="source-tag__kicker">SOURCE</span>
      <span className="source-tag__name">{source.name}</span>
      <span className="source-tag__arrow" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}
