// The one rule this component exists to enforce: null and 0 must never look the same.
// A real zero renders bold and plain. A null renders as a muted, dashed "no data" glyph
// with its own accessible label -- never silently coerced to "0".
export function Stat({
  value,
  suffix,
}: {
  value: number | null | undefined;
  suffix?: string;
}) {
  if (value === null || value === undefined) {
    return (
      <span className="stat stat--nodata" aria-label="no data on file">
        <span aria-hidden="true">—</span>
      </span>
    );
  }
  return (
    <span className="stat">
      {value.toLocaleString()}
      {suffix ? <span className="stat__suffix"> {suffix}</span> : null}
    </span>
  );
}
