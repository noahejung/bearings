// The information band + wordmark -- DESIGN.md §5 "the engineering
// drawing register... reads as authority" and §6 "the wordmark is the
// single largest, most considered mark." No theme toggle: VISUAL.md locks
// one palette (tDR Steel set) with no alternate era, and a physical-paper
// municipal-record metaphor structurally has no "dark mode."
//
// VISUAL.md §1's NO-LARP rule: the band carries real identifiers only (the
// H3 index once a profile has loaded) -- no fictional bureau name, no
// invented catalogue code. Cut 2026-07-14.
export function Header({ cell }: { cell?: string | null }) {
  return (
    <>
      <div className="band">
        <span>{cell ? `H3 · ${cell}` : "—"}</span>
      </div>
      <a className="masthead" href="/">
        <h1 className="masthead__word">
          Bearings<sup>™</sup>
        </h1>
        <p className="masthead__tag">Get your bearings before you sign</p>
      </a>
    </>
  );
}
