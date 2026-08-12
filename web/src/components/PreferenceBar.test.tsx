import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreferenceBar } from "./PreferenceBar";

// LAYOUT-V3 WAVE 1d item 11 (2026-08-03, SPEC-layout-v3.md §8): the
// pin-a-place search form (and its own geocode fetch stubbing) moved to
// AddressSearch.test.tsx along with the consolidated bar's own new "save"
// button (renamed from "pin" in WAVE 6f item 8, 2026-08-11) -- this file
// now covers only what PreferenceBar itself still owns: the category chips
// and the saved-places list/remove control.

describe("PreferenceBar", () => {
  it("renders exactly the 6 real category chips, none pressed by default", () => {
    render(
      <PreferenceBar
        activeCategories={new Set()}
        onToggleCategory={vi.fn()}
        saved={[]}
        onUnsave={vi.fn()}
      />,
    );
    for (const label of ["groceries", "cafes", "bars & venues", "parks", "gyms", "transit"]) {
      const chip = screen.getByRole("button", { name: label });
      expect(chip).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("toggling a chip calls onToggleCategory with the real category key, not the display label", () => {
    const onToggle = vi.fn();
    render(
      <PreferenceBar
        activeCategories={new Set()}
        onToggleCategory={onToggle}
        saved={[]}
        onUnsave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "cafes" }));
    expect(onToggle).toHaveBeenCalledWith("cafe");
  });

  it("a chip already in activeCategories renders aria-pressed=true", () => {
    render(
      <PreferenceBar
        activeCategories={new Set(["park", "transit"])}
        onToggleCategory={vi.fn()}
        saved={[]}
        onUnsave={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "parks" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "transit" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "cafes" })).toHaveAttribute("aria-pressed", "false");
  });

  it("renders every saved place with a working unsave control, wired to the real label", () => {
    const onUnsave = vi.fn();
    render(
      <PreferenceBar
        activeCategories={new Set()}
        onToggleCategory={vi.fn()}
        saved={[{ label: "Nowadays", lat: 40.71, lng: -73.96 }]}
        onUnsave={onUnsave}
      />,
    );
    expect(screen.getByText("Nowadays")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /unsave nowadays/i }));
    expect(onUnsave).toHaveBeenCalledWith("Nowadays");
  });
});
