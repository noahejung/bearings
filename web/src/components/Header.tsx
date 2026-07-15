// The information band + wordmark -- DESIGN.md §5 "the engineering
// drawing register... reads as authority" and §6 "the wordmark is the
// single largest, most considered mark." No theme toggle: VISUAL.md locks
// one palette (tDR Steel set) with no alternate era, and a physical-paper
// municipal-record metaphor structurally has no "dark mode."
//
// VISUAL.md §1's NO-LARP rule: the band carries real identifiers only --
// no fictional bureau name, no invented catalogue code (cut 2026-07-14).
// VISUAL.md §1's 2026-07-15 newcomer-audience addendum revised this
// further: the identifier itself must be something a newcomer recognizes,
// so the band shows the loaded address, not the internal H3 cell index.
export function Header({ address }: { address?: string | null }) {
  return (
    <>
      <div className="band">
        <span>{address ?? "—"}</span>
      </div>
      <a className="masthead" href="/">
        <h1 className="masthead__word">Bearings</h1>
        <p className="masthead__tag">Enter a New York City address to see what public records say about it.</p>
      </a>
    </>
  );
}
