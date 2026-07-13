import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BuildingCard } from "./BuildingCard";
import type { Building } from "../types";

const SOURCE = { name: "NYC PLUTO + HPD", url: "https://data.cityofnewyork.us/d/wvxf-dwi5" };

const WITH_RECORD: Building = {
  year_built: 1931,
  era: "prewar",
  era_note: "Pre-war walk-up stock often carries rent-stabilised units.",
  hpd_open_violations: { class_a: 1, class_b: 0, class_c: 2 },
  source: SOURCE,
};

// Confirmed reachable via bearings/profile.py's _building(): when an address
// has no BBL, year_built, era, era_note, AND hpd_open_violations are all
// null together -- but the type this component consumed until this fix
// declared hpd_open_violations non-nullable, and the component dereferenced
// `violations.class_c` unconditionally. A real address hitting this path
// crashed the whole card in the browser (a TypeError, not a wrong number).
const NO_RECORD: Building = {
  year_built: null,
  era: null,
  era_note: null,
  hpd_open_violations: null,
  source: SOURCE,
};

describe("BuildingCard", () => {
  it("renders violation counts when a PLUTO/HPD record exists", () => {
    render(<BuildingCard building={WITH_RECORD} />);
    expect(screen.getByText("1931")).toBeInTheDocument();
    expect(screen.getByText(/immediately hazardous/)).toBeInTheDocument();
  });

  it("does not crash and shows a real fallback when hpd_open_violations is null", () => {
    render(<BuildingCard building={NO_RECORD} />);
    expect(screen.getByText(/No PLUTO\/HPD record/)).toBeInTheDocument();
  });
});
