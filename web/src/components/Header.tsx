import { catalogueCode } from "../lib/catalogue";

// The information band + wordmark -- DESIGN.md §5 "the engineering
// drawing register... reads as authority" and §6 "the wordmark is the
// single largest, most considered mark." No theme toggle: VISUAL.md locks
// one palette (tDR Steel set) with no alternate era, and a physical-paper
// municipal-record metaphor structurally has no "dark mode."
export function Header({ cell }: { cell?: string | null }) {
  return (
    <>
      <div className="band">
        <span>{catalogueCode(cell)}</span>
        <span className="band__steel">Peoples Bureau for Consumer Information</span>
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
