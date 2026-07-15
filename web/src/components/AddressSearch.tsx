import { useId, type FormEvent } from "react";
import type { ExampleAddress } from "../data/examples";

interface AddressSearchProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (address: string) => void;
  examples: ExampleAddress[];
  loading: boolean;
  error: string | null;
  /** true once a profile has already loaded -- renders the slim compact bar instead of the hero. */
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
    <section className={`search${compact ? " search--compact" : ""}`}>
      {!compact && (
        <div className="search__intro">
          <h2 className="search__headline">
            See what <em>public records</em> say about daily life at an address.
          </h2>
          <p className="search__sub">
            Real train times, not distance to the platform. Noise complaints, tree counts,
            nearby crime, and a building's own safety record — every number sourced, none of
            it opinion.
          </p>
        </div>
      )}

      <form className="search__form" onSubmit={handleSubmit} role="search">
        <label className="sr-only" htmlFor={inputId}>
          NYC address
        </label>
        <div className="search__field">
          <input
            id={inputId}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="350 5TH AVE, MANHATTAN"
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
        <p className="search__error" role="alert" id={errorId}>
          {error}
        </p>
      )}

      <div className="examples" aria-label="Example addresses">
        <span className="examples__label">Or try —</span>
        <ul>
          {examples.map((ex) => (
            <li key={ex.address}>
              <button
                type="button"
                className="example"
                onClick={() => onSubmit(ex.address)}
                disabled={loading}
              >
                {ex.featured && <span className="example__badge">★ fact-check ready</span>}
                <span className="example__label">{ex.label}</span>
                <span className="example__sub">{ex.sublabel}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
