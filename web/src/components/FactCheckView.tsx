import { useId, type FormEvent } from "react";
import type { ClaimStatus, FactcheckResult } from "../types";
import { ClaimCard } from "./ClaimCard";
import { statusLabel } from "./StatusStamp";

const TALLY_ORDER: ClaimStatus[] = ["supported", "contradicted", "unfalsifiable", "no_data"];

function Tally({ result }: { result: FactcheckResult }) {
  const counts: Record<ClaimStatus, number> = {
    supported: 0,
    contradicted: 0,
    unfalsifiable: 0,
    no_data: 0,
  };
  for (const c of result.claims) counts[c.status] += 1;

  return (
    <ul className="tally" aria-label="Claim status counts">
      {TALLY_ORDER.map((status) => (
        <li key={status} className={`tally__item tally__item--${status}`}>
          <span className="tally__count">{counts[status]}</span>
          <span className="tally__label">{statusLabel(status)}</span>
        </li>
      ))}
    </ul>
  );
}

interface FactCheckViewProps {
  address: string | null;
  listingText: string;
  onListingTextChange: (v: string) => void;
  onSubmit: () => void;
  onLoadExample: () => void;
  loading: boolean;
  error: string | null;
  result: FactcheckResult | null;
}

export function FactCheckView({
  address,
  listingText,
  onListingTextChange,
  onSubmit,
  onLoadExample,
  loading,
  error,
  result,
}: FactCheckViewProps) {
  const textareaId = useId();
  const canSubmit = Boolean(address) && listingText.trim().length > 0 && !loading;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) onSubmit();
  }

  return (
    <section className="factcheck" id="factcheck" aria-labelledby="factcheck-heading">
      <header className="report__head">
        <p className="report__kicker mono">The fact-check</p>
        <h2 className="report__title" id="factcheck-heading">
          Paste a listing. We'll pull the record on every claim.
        </h2>
        <p className="factcheck__lede">
          Every marketing phrase gets matched to a predicate and checked against the same
          data behind the report above. Four outcomes are possible — confirmed,
          contradicted, no record, or genuinely unfalsifiable. That last one isn't a
          failure: some claims really can't be checked against any dataset, and saying so
          plainly is the honest answer.
        </p>
      </header>

      <form className="factcheck__form" onSubmit={handleSubmit}>
        <div>
          <label htmlFor={textareaId}>Listing description</label>
          <textarea
            id={textareaId}
            rows={5}
            placeholder="Paste a listing description — 'quiet, tree-lined street, steps from the subway...'"
            value={listingText}
            onChange={(e) => onListingTextChange(e.target.value)}
          />
        </div>
        <div className="factcheck__actions">
          <button type="button" className="button button--ghost" onClick={onLoadExample} disabled={loading}>
            Load the example listing
          </button>
          <button type="submit" className="button" disabled={!canSubmit}>
            {loading ? "Checking…" : "Check this listing"}
          </button>
        </div>
        {!address && (
          <p className="factcheck__hint">Pull a neighborhood record above first.</p>
        )}
      </form>

      {error && (
        <p className="search__error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="factcheck-results">
          {result.claims.length === 0 ? (
            <p className="field__empty">
              No checkable marketing phrases found in that text. Try pasting a fuller
              listing description, or load the example.
            </p>
          ) : (
            <>
              <Tally result={result} />
              <ul className="claims">
                {result.claims.map((claim, i) => (
                  <ClaimCard claim={claim} key={`${claim.predicate}-${i}`} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
