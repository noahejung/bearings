// The verdict stamp -- DESIGN.md §6 "Accent": one warning mark, used to
// direct the eye and sign the argument. Four states shared by every report
// field and every fact-check claim, so there is exactly one stamp
// vocabulary in the app, not two that could drift ("confirmed" here,
// "supported" there). Declarative, all-caps, unhedged -- tDR voice
// (DESIGN.md §7): the report says what the record found, never a softened
// gloss on it.
export type StampVariant = "confirmed" | "contradicted" | "unverifiable" | "no_data";

const LABELS: Record<StampVariant, string> = {
  confirmed: "CONFIRMED",
  contradicted: "CONTRADICTED",
  unverifiable: "UNVERIFIABLE",
  no_data: "NO DATA",
};

export function stampLabel(variant: StampVariant): string {
  return LABELS[variant];
}

export function Stamp({
  variant,
  compact = false,
}: {
  variant: StampVariant;
  compact?: boolean;
}) {
  return (
    <span className={`stamp stamp--${variant}${compact ? " stamp--compact" : ""}`}>
      {LABELS[variant]}
    </span>
  );
}
