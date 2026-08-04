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
          Check a listing's claims against the record above.
        </h2>
        <p className="factcheck__lede">
          Checked against the same data as the report above. Four outcomes: confirmed,
          contradicted, no record on file, or unfalsifiable — a claim no dataset here can
          check.
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
            See a worked example (swaps to Sedgwick Ave)
          </button>
          <button type="submit" className="button" disabled={!canSubmit}>
            {/* UX-FIX 2026-08-03 (audit finding #10, "fact-check submission
                gives no felt-progress affordance during a multi-second
                wait"): reuses the exact `.loading__dots` animated-ellipsis
                idiom App.tsx's own "Pulling the record" sidepanel
                placeholder already established, rather than inventing a
                second loading vocabulary or a fake progress bar/percentage
                (this really is a multi-second live cross-reference against
                several real datasets -- README's own documented cost -- so
                there is no honest sub-step to report before it's done). */}
            {loading ? (
              <>
                Checking<span className="loading__dots" aria-hidden="true" />
              </>
            ) : (
              "Check this listing"
            )}
          </button>
        </div>
        {!address && (
          <p className="factcheck__hint">Pull a neighborhood record above first.</p>
        )}
        {loading && (
          <p className="factcheck__hint" role="status">
            Checking against several real, live datasets — this can take a few seconds.
          </p>
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
              No checkable marketing phrases in that text. Try a fuller listing, or load
              the example.
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
