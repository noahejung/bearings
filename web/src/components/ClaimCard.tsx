import type { ReactNode } from "react";
import type { Claim } from "../types";
import { SourceTag } from "./SourceTag";
import { StatusStamp } from "./StatusStamp";

// Bolds the *exact* evidence value where it appears verbatim in the sentence -- not
// every digit sequence, which would also catch incidental numbers like a station name
// ("181 St"). If the value isn't found verbatim (shouldn't happen, but this must never
// throw or silently misrender), it falls back to plain text.
function EvidenceText({ text, value }: { text: string; value: number | null }) {
  if (value === null) return <>{text}</>;

  const parts = text.split(new RegExp(`\\b(${value})\\b`, "g"));
  if (parts.length === 1) return <>{text}</>;

  const nodes: ReactNode[] = parts.map((part, i) =>
    part === String(value) ? (
      <strong className="claim__evidence-number" key={i}>
        {value.toLocaleString()}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
  return <>{nodes}</>;
}

export function ClaimCard({ claim }: { claim: Claim }) {
  return (
    <li className={`claim claim--${claim.status === "supported" ? "confirmed" : claim.status}`}>
      <div className="claim__top">
        <div className="claim__quote">
          <p className="claim__quote-kicker">The listing says</p>
          <p className="claim__quote-text">&ldquo;{claim.quote}&rdquo;</p>
        </div>
        <StatusStamp status={claim.status} />
      </div>

      <div className="claim__evidence">
        <p className="claim__evidence-kicker">The record says</p>
        <p className="claim__evidence-text">
          <EvidenceText text={claim.evidence} value={claim.value} />
        </p>
      </div>

      <p className="field__provenance">
        <SourceTag source={claim.source} />
      </p>
    </li>
  );
}
