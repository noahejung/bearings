import type { ClaimStatus } from "../types";

// Display labels are a human gloss on the API's four exact status values -- the
// underlying `status` is never renamed, only re-worded for the reader. Every label
// describes what the *record* did (confirmed it / contradicted it / couldn't check it /
// has nothing on file), never a judgement about the listing or the landlord. That's the
// whole "report the data, never render a verdict" rule, applied to word choice.
const LABELS: Record<ClaimStatus, string> = {
  supported: "Confirmed by the record",
  contradicted: "Contradicted by the record",
  unfalsifiable: "Unverifiable — puffery",
  no_data: "No record on file",
};

export function statusLabel(status: ClaimStatus): string {
  return LABELS[status];
}

export function StatusStamp({ status }: { status: ClaimStatus }) {
  return (
    <span className={`stamp stamp--${status}`}>
      <span className="stamp__label">{LABELS[status]}</span>
    </span>
  );
}
