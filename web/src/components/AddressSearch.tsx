import { useId, type FormEvent } from "react";
import type { ExampleAddress } from "../data/examples";

interface AddressSearchProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (address: string) => void;
  examples: ExampleAddress[];
  loading: boolean;
  error: string | null;
  /** true once a profile has already loaded -- renders the slim sticky bar instead of the hero. */
  compact: boolean;
}

export function AddressSearch({
  value,
  onChange,
  onSubmit,
  examples,
  loading,
  error,
  compact,
}: AddressSearchProps) {
  const inputId = useId();
  const errorId = useId();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <section className={`address-search${compact ? " address-search--compact" : ""}`}>
      {!compact && (
        <div className="address-search__intro">
          <p className="kicker">A field report on daily life, built from public records</p>
          <h1 className="address-search__headline">
            What's it actually like <em>there?</em>
          </h1>
          <p className="address-search__sub">
            Real train times, not distance to the platform. 311 complaints, tree counts,
            precinct crime, and a building's own violation history — every number sourced,
            nothing editorialised.
          </p>
        </div>
      )}

      <form className="address-search__form" onSubmit={handleSubmit} role="search">
        <label className="sr-only" htmlFor={inputId}>
          NYC address
        </label>
        <div className="address-search__field">
          <span className="address-search__field-icon" aria-hidden="true">
            ⊙
          </span>
          <input
            id={inputId}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="350 5th Ave, Manhattan"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <button type="submit" disabled={loading || value.trim().length === 0}>
            {loading ? "Pulling…" : "Pull the record"}
          </button>
        </div>
      </form>

      {error && (
        <p className="address-search__error" role="alert" id={errorId}>
          {error}
        </p>
      )}

      <div className="example-chips" aria-label="Example addresses">
        <span className="example-chips__label">Or try:</span>
        <ul>
          {examples.map((ex) => (
            <li key={ex.address}>
              <button
                type="button"
                className="example-chip"
                onClick={() => onSubmit(ex.address)}
                disabled={loading}
              >
                {ex.featured && <span className="example-chip__badge">★ fact-check ready</span>}
                <span className="example-chip__label">{ex.label}</span>
                <span className="example-chip__sublabel">{ex.sublabel}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
