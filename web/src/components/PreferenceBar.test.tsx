import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferenceBar } from "./PreferenceBar";

// A real geocode contract shape (mirrors web/src/types.ts's GeocodeResult),
// reused from this repo's own App.test.tsx fixture -- pin search calls the
// SAME GET /api/geocode function App.tsx's own address search already
// stubs a fetch for, so this is not a new API surface to fake, just the
// existing one exercised from a different component.
const GEOCODE_RESULT = {
  label: "350 5 AVENUE, New York, NY, USA",
  lat: 40.748441,
  lng: -73.985656,
  bbl: "1008350041",
  cell: "892a100d2d7ffff",
};

function stubGeocodeFetch(overrides?: { ok?: boolean; message?: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/geocode")) {
        if (overrides?.ok === false) {
          return Promise.resolve(
            new Response(JSON.stringify({ detail: overrides.message ?? "not found" }), { status: 422 }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify(GEOCODE_RESULT), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

beforeEach(() => {
  stubGeocodeFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PreferenceBar", () => {
  it("renders exactly the 6 real category chips, none pressed by default", () => {
    render(
      <PreferenceBar
        activeCategories={new Set()}
        onToggleCategory={vi.fn()}
        pins={[]}
        onAddPin={vi.fn()}
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
        onAddPin={vi.fn()}
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
        onAddPin={vi.fn()}
        onRemovePin={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "parks" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "transit" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "cafes" })).toHaveAttribute("aria-pressed", "false");
  });

  it("pinning a real place calls onAddPin with the geocoded label/lat/lng, and clears the input", async () => {
    const onAddPin = vi.fn();
    render(
      <PreferenceBar
        activeCategories={new Set()}
        onToggleCategory={vi.fn()}
        pins={[]}
        onAddPin={onAddPin}
        onRemovePin={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText(/pin a place/i);
    fireEvent.change(input, { target: { value: "350 5th Ave, Manhattan" } });
    fireEvent.click(screen.getByRole("button", { name: /pin it/i }));

    await waitFor(() =>
      expect(onAddPin).toHaveBeenCalledWith({
        label: GEOCODE_RESULT.label,
        lat: GEOCODE_RESULT.lat,
        lng: GEOCODE_RESULT.lng,
      }),
    );
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("a failed pin search shows the geocoder's own honest error message, never a fabricated pin", async () => {
    stubGeocodeFetch({ ok: false, message: "We couldn't find that address in New York City." });
    const onAddPin = vi.fn();
    render(
      <PreferenceBar
        activeCategories={new Set()}
        onToggleCategory={vi.fn()}
        pins={[]}
        onAddPin={onAddPin}
        onRemovePin={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/pin a place/i), {
      target: { value: "qqqqqqqqzzzzzzz not a real place" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pin it/i }));

    await waitFor(() =>
      expect(screen.getByText(/We couldn.t find that address/i)).toBeInTheDocument(),
    );
    expect(onAddPin).not.toHaveBeenCalled();
  });

  it("renders every pin with a working remove control, wired to the real label", () => {
    const onRemovePin = vi.fn();
    render(
      <PreferenceBar
        activeCategories={new Set()}
        onToggleCategory={vi.fn()}
        pins={[{ label: "Nowadays", lat: 40.71, lng: -73.96 }]}
        onAddPin={vi.fn()}
        onRemovePin={onRemovePin}
      />,
    );
    expect(screen.getByText("Nowadays")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove pin: nowadays/i }));
    expect(onRemovePin).toHaveBeenCalledWith("Nowadays");
  });
});
