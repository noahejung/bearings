import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSavedPlaces, saveSavedPlaces, type SavedPlace } from "./preferences";

// WAVE 6f item 8 (2026-08-11, Noah: "instead of pin can we just click
// save"): loadSavedPlaces()/saveSavedPlaces() are the localStorage bridge
// SPEC-data-layer-v2.md §6 named as the client-side interim step while
// real accounts stay on hold -- this file is the direct test of that
// bridge (App.tsx's own persistence effect is covered indirectly via
// App.test.tsx, but the storage/parsing logic itself belongs here).

const PLACE: SavedPlace = { label: "245 MC GUINNESS BOULEVARD, Brooklyn, NY, USA", lat: 40.73, lng: -73.95 };

describe("loadSavedPlaces/saveSavedPlaces", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("a first-ever visit (nothing in localStorage) loads an empty list, not an error", () => {
    expect(loadSavedPlaces()).toEqual([]);
  });

  it("round-trips a real saved place through localStorage", () => {
    saveSavedPlaces([PLACE]);
    expect(loadSavedPlaces()).toEqual([PLACE]);
  });

  it("a corrupted value in localStorage loads as an empty list, never a thrown exception", () => {
    window.localStorage.setItem("bearings.savedPlaces", "{not valid json");
    expect(loadSavedPlaces()).toEqual([]);
  });

  it("a malformed entry (wrong shape) is filtered out rather than crashing the whole load", () => {
    window.localStorage.setItem(
      "bearings.savedPlaces",
      JSON.stringify([PLACE, { label: "no lat/lng" }, "not even an object", null]),
    );
    expect(loadSavedPlaces()).toEqual([PLACE]);
  });

  it("saving an empty list clears any previously saved places", () => {
    saveSavedPlaces([PLACE]);
    saveSavedPlaces([]);
    expect(loadSavedPlaces()).toEqual([]);
  });
});
