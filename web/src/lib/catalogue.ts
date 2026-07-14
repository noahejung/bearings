// "The catalogue number is the timestamp" -- DESIGN.md §4. Every report
// gets a BRG—YYYY—MMDD—xx code (VISUAL.md §4). The two-character suffix is
// derived from the real H3 cell index, not a random/decorative value --
// same address + same day always produces the same code, and the code
// itself traces back to real data rather than being pure ornament.
export function catalogueCode(cell: string | null | undefined, date = new Date()): string {
  const year = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const suffix = cell ? cell.slice(2, 4).toUpperCase() : "00";
  return `BRG—${year}—${mm}${dd}—${suffix}`;
}
