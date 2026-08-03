import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressSearch } from "./AddressSearch";

// LAYOUT-V3 WAVE 1d items 5 + 11 (2026-08-03, SPEC-layout-v3.md §8): this
// file replaces the old example-chips coverage (item 5 -- the chips are
// gone, nothing to test) and absorbs PreferenceBar.test.tsx's former
// pin-search tests (item 11 -- pinning moved to this bar's own "pin"
// button), plus new coverage for the debounced typeahead this bar now
// drives (GET /api/geocode/autocomplete).

const AUTOCOMPLETE_RESULTS = {
  results: [
    { label: "350 5 AVENUE, New York, NY, USA", lat: 40.748441, lng: -73.985656 },
    { label: "350 5 AVENUE, Brooklyn, NY, USA", lat: 40.672191, lng: -73.984456 },
  ],
};

const GEOCODE_RESULT = {
  label: "350 5 AVENUE, New York, NY, USA",
  lat: 40.748441,
  lng: -73.985656,
  bbl: "1008350041",
  cell: "892a100d2d7ffff",
};

function stubFetch(overrides?: { autocompleteFails?: boolean; geocodeFails?: boolean; message?: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/geocode/autocomplete")) {
        if (overrides?.autocompleteFails) {
          return Promise.resolve(new Response("upstream down", { status: 502 }));
        }
        return Promise.resolve(new Response(JSON.stringify(AUTOCOMPLETE_RESULTS), { status: 200 }));
      }
      if (url.includes("/api/geocode")) {
        if (overrides?.geocodeFails) {
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

function baseProps(overrides?: Partial<Parameters<typeof AddressSearch>[0]>) {
  return {
    value: "",
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onPin: vi.fn(),
    pinLoading: false,
    pinError: null,
    loading: false,
    error: null,
    compact: false,
    ...overrides,
  };
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AddressSearch", () => {
  it("submits the typed address via onSubmit", () => {
    const onSubmit = vi.fn();
    render(<AddressSearch {...baseProps({ value: "350 5th Ave, Manhattan", onSubmit })} />);
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));
    expect(onSubmit).toHaveBeenCalledWith("350 5th Ave, Manhattan");
  });

  it("no longer renders example address chips (item 5 -- cut, not relocated)", () => {
    render(<AddressSearch {...baseProps()} />);
    expect(screen.queryByText(/or try/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fact-check ready/i)).not.toBeInTheDocument();
  });

  it("debounces a real typeahead call and shows real GeoSearch candidates", async () => {
    const onChange = vi.fn();
    render(<AddressSearch {...baseProps({ value: "350 5th", onChange })} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /New York, NY/i })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: /Brooklyn, NY/i })).toBeInTheDocument();
  });

  it("does not call the typeahead for fewer than 3 characters", async () => {
    render(<AddressSearch {...baseProps({ value: "35" })} />);
    // Give the debounce window plenty of time to have fired if it were
    // going to -- then assert no fetch was ever made.
    await new Promise((r) => setTimeout(r, 400));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("picking a suggestion fills the field and submits it immediately", async () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(<AddressSearch {...baseProps({ value: "350 5th", onSubmit, onChange })} />);
    const option = await screen.findByRole("option", { name: /New York, NY/i });
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(AUTOCOMPLETE_RESULTS.results[0].label);
    expect(onSubmit).toHaveBeenCalledWith(AUTOCOMPLETE_RESULTS.results[0].label);
  });

  it("the pin button pins whatever address is currently typed, via onPin", () => {
    const onPin = vi.fn();
    render(<AddressSearch {...baseProps({ value: "350 5th Ave, Manhattan", onPin })} />);
    fireEvent.click(screen.getByRole("button", { name: /pin it/i }));
    expect(onPin).toHaveBeenCalledWith("350 5th Ave, Manhattan");
  });

  it("shows the caller's own pin error, never silently swallowing a failed pin", () => {
    render(<AddressSearch {...baseProps({ value: "x", pinError: "We couldn't find that address in New York City." })} />);
    expect(screen.getByText(/We couldn.t find that address/i)).toBeInTheDocument();
  });

  it("does not reopen the dropdown after submitting the typed address (regression: a slow debounced fetch used to resolve after submit and reopen it)", async () => {
    function Wrapper() {
      const [value, setValue] = useState("350 5th");
      return <AddressSearch {...baseProps({ value, onChange: setValue })} />;
    }
    render(<Wrapper />);
    // Let the debounce actually schedule (but don't await its resolution --
    // submit lands mid-flight, matching the live bug's own timing).
    await new Promise((r) => setTimeout(r, 200));
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));
    // Give the in-flight fetch's own promise plenty of time to resolve.
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("does not reopen the dropdown after picking a suggestion (regression: onChange's own value update used to re-trigger a fresh fetch)", async () => {
    function Wrapper() {
      const [value, setValue] = useState("350 5th");
      return <AddressSearch {...baseProps({ value, onChange: setValue })} />;
    }
    render(<Wrapper />);
    const option = await screen.findByRole("option", { name: /New York, NY/i });
    fireEvent.click(option);
    // The picked label re-renders the input with a new `value` -- give the
    // debounce window plenty of time to have fired again if it were going to.
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("a failed autocomplete call is non-fatal -- the form still works as a plain search", async () => {
    stubFetch({ autocompleteFails: true });
    const onSubmit = vi.fn();
    render(<AddressSearch {...baseProps({ value: "350 5th Ave, Manhattan", onSubmit })} />);
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));
    expect(onSubmit).toHaveBeenCalledWith("350 5th Ave, Manhattan");
  });
});
