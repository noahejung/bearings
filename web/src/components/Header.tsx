import type { Theme } from "../hooks/useTheme";

export function Header({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="wordmark" href="/">
          <span className="wordmark__mark" aria-hidden="true">
            ⊙
          </span>
          <span className="wordmark__text">
            bearings
            <span className="wordmark__kicker">get your bearings before you sign</span>
          </span>
        </a>
        <button
          type="button"
          className="theme-toggle"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="12" cy="12" r="4.6" fill="currentColor" />
              <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <line x1="12" y1="1.5" x2="12" y2="4.2" />
                <line x1="12" y1="19.8" x2="12" y2="22.5" />
                <line x1="1.5" y1="12" x2="4.2" y2="12" />
                <line x1="19.8" y1="12" x2="22.5" y2="12" />
                <line x1="4.6" y1="4.6" x2="6.5" y2="6.5" />
                <line x1="17.5" y1="17.5" x2="19.4" y2="19.4" />
                <line x1="4.6" y1="19.4" x2="6.5" y2="17.5" />
                <line x1="17.5" y1="6.5" x2="19.4" y2="4.6" />
              </g>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M20.2 14.8A8.6 8.6 0 1 1 9.2 3.8a7 7 0 0 0 11 11z"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}
