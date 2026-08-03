import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreferenceBar } from "./PreferenceBar";

// LAYOUT-V3 WAVE 1d item 11 (2026-08-03, SPEC-layout-v3.md §8): the
// pin-a-place search form (and its own geocode fetch stubbing) moved to
// AddressSearch.test.tsx along with the consolidated bar's own new "pin"
// button -- this file now covers only what PreferenceBar itself still
// owns: the category chips and the pinned-places list/remove control.

describe("PreferenceBar", () => {
  it("renders exactly the 6 real category chips, none pressed by default", () => {
    render(
      <PreferenceBar
        activeCategories={new Set()}
        onToggleCategory={vi.fn()}
        pins={[]}
        onRemovePin={vi.fn()}
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
        pins={[]}
        onRemovePin={vi.fn()}
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
        pins={[]}
        onRemovePin={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "parks" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "transit" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "cafes" })).toHaveAttribute("aria-pressed", "false");
  });

  it("renders every pin with a working remove control, wired to the real label", () => {
    const onRemovePin = vi.fn();
    render(
      <PreferenceBar
        activeCategories={new Set()}
        onToggleCategory={vi.fn()}
        pins={[{ label: "Nowadays", lat: 40.71, lng: -73.96 }]}
        onRemovePin={onRemovePin}
      />,
    );
    expect(screen.getByText("Nowadays")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove pin: nowadays/i }));
    expect(onRemovePin).toHaveBeenCalledWith("Nowadays");
  });
});
