// SPEC-building-card-v2.md Part B: the card's photo states.
//
// The payloads below are the real shapes GET /api/building/{bbl}/photo
// returns, copied from live responses recorded 2026-09-07 -- the Empire
// State Building (1008350041, three files, nearest 1.2 m), 360 Smith St
// (3004590024, one file, a subway mosaic 20.2 m away) and 161 Newel St
// (3026230011, nothing within 40 m). They are fixtures for pure rendering
// functions; the endpoint itself is tested against the live Commons API in
// tests/test_commons.py and tests/test_api.py.

import { describe, expect, it } from "vitest";
import {
  attributionLine,
  buildPhotoBlock,
  displayTitle,
  distanceLabel,
  photoView,
  provenanceLine,
  type PhotoState,
} from "./buildingPhoto";
import type { BuildingPhoto, BuildingPhotoResponse } from "../types";

const SOURCE = {
  name: "Wikimedia Commons",
  url: "https://commons.wikimedia.org/wiki/Commons:Geocoding",
  as_of: "2026-09-07",
  baked: false,
};

// The Empire State Building's own nearest file, verbatim from the live API.
const LANDMARK_PHOTO: BuildingPhoto = {
  title: "Empire State Building from Rockefeller Center's 70th floor (4898085460).jpg",
  thumb_url:
    "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/80/Empire_State_Building_from_Rockefeller_Center%27s_70th_floor_%284898085460%29.jpg/500px-Empire_State_Building_from_Rockefeller_Center%27s_70th_floor_%284898085460%29.jpg",
  thumb_width: 480,
  thumb_height: 715,
  description_url:
    "https://commons.wikimedia.org/wiki/File:Empire_State_Building_from_Rockefeller_Center%27s_70th_floor_(4898085460).jpg",
  artist: "Bill Abbott",
  license: "CC BY-SA 2.0",
  license_url: "https://creativecommons.org/licenses/by-sa/2.0",
  distance_m: 1.2,
};

// 360 Smith St's one and only neighbour: a subway mosaic tile, 20.2 m away.
const NOT_THIS_BUILDING_PHOTO: BuildingPhoto = {
  title: "Carroll Street Station Mosaic Tile.jpg",
  thumb_url:
    "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/92/Carroll_Street_Station_Mosaic_Tile.jpg/500px-Carroll_Street_Station_Mosaic_Tile.jpg",
  thumb_width: 480,
  thumb_height: 360,
  description_url: "https://commons.wikimedia.org/wiki/File:Carroll_Street_Station_Mosaic_Tile.jpg",
  artist: "Kidfly182",
  license: "CC BY-SA 4.0",
  license_url: "https://creativecommons.org/licenses/by-sa/4.0",
  distance_m: 20.2,
};

function response(overrides: Partial<BuildingPhotoResponse> = {}): BuildingPhotoResponse {
  return {
    bbl: "1008350041",
    point: { lat: 40.748441, lng: -73.985753 },
    photo: LANDMARK_PHOTO,
    candidates: 3,
    usable: 3,
    radius_m: 40,
    source: SOURCE,
    ...overrides,
  };
}

const ready = (overrides: Partial<BuildingPhotoResponse> = {}): PhotoState => ({
  status: "ready",
  response: response(overrides),
});

describe("photo copy", () => {
  it("drops the file extension from the displayed title but keeps the name", () => {
    expect(displayTitle("Carroll Street Station Mosaic Tile.jpg")).toBe(
      "Carroll Street Station Mosaic Tile",
    );
    expect(displayTitle("Some.Building.PNG")).toBe("Some.Building");
    expect(displayTitle("No extension here")).toBe("No extension here");
  });

  it("rounds the distance to whole metres and never invents one", () => {
    expect(distanceLabel(20.2)).toBe("20 m away");
    expect(distanceLabel(1.2)).toBe("1 m away");
    expect(distanceLabel(0.4)).toBe("under 1 m away");
    // A distance nobody measured must not be printed as a number.
    expect(distanceLabel(null)).toBeNull();
  });

  it("names the author and the license, and says so when the author is missing", () => {
    expect(attributionLine(LANDMARK_PHOTO)).toBe(
      "Photo: Bill Abbott, CC BY-SA 2.0, via Wikimedia Commons",
    );
    expect(attributionLine({ ...LANDMARK_PHOTO, artist: null })).toBe(
      "Photo: author not named on the file page, CC BY-SA 2.0, via Wikimedia Commons",
    );
  });

  it("introduces every photo by where it was cataloged, never as this building", () => {
    // The whole rule: nothing in the Commons API says what a picture
    // depicts, so the card must not say it either.
    expect(provenanceLine(NOT_THIS_BUILDING_PHOTO)).toBe(
      "Cataloged 20 m away — “Carroll Street Station Mosaic Tile”",
    );
    expect(provenanceLine(LANDMARK_PHOTO)).toBe(
      "Cataloged 1 m away — “Empire State Building from Rockefeller Center's 70th floor (4898085460)”",
    );
    expect(provenanceLine({ ...LANDMARK_PHOTO, distance_m: null })).toContain("Cataloged nearby");
  });
});

describe("photoView states", () => {
  it("shows a placeholder while the lookup is in flight", () => {
    const view = photoView({ status: "loading" });
    expect(view).toEqual({
      kind: "note",
      note: { text: "looking for a photo…", tone: "loading" },
    });
  });

  it("renders the photo when Commons has one", () => {
    const view = photoView(ready());
    expect(view.kind).toBe("photo");
    if (view.kind === "photo") expect(view.photo.title).toBe(LANDMARK_PHOTO.title);
  });

  it("says nothing is cataloged when Commons genuinely has nothing", () => {
    const view = photoView(ready({ photo: null, candidates: 0, usable: 0 }));
    expect(view.kind).toBe("note");
    if (view.kind === "note") {
      expect(view.note.text).toBe("No photo cataloged on Wikimedia Commons within 40 m");
      expect(view.note.tone).toBe("empty");
    }
  });

  it("quotes the radius the server actually searched, not a hardcoded one", () => {
    const view = photoView(ready({ photo: null, candidates: 0, usable: 0, radius_m: 120 }));
    if (view.kind === "note") expect(view.note.text).toContain("within 120 m");
  });

  it("distinguishes 'nothing here' from 'nothing we can credit'", () => {
    const view = photoView(ready({ photo: null, candidates: 2, usable: 0 }));
    expect(view.kind).toBe("note");
    if (view.kind === "note") {
      expect(view.note.text).toBe("2 files cataloged within 40 m, none this card can credit");
      expect(view.note.tone).toBe("empty");
    }
  });

  it("says 'not available' when the lookup failed, never 'no photo'", () => {
    // The rule this whole file exists for: a request that failed is not an
    // answer about what Commons holds.
    const view = photoView(
      ready({
        photo: { unavailable: true, reason: "Wikimedia Commons did not answer within 2.0s." },
        candidates: null,
        usable: null,
      }),
    );
    expect(view.kind).toBe("note");
    if (view.kind === "note") {
      expect(view.note.text).toBe("Photo lookup not available");
      expect(view.note.tone).toBe("unavailable");
      expect(view.note.detail).toContain("did not answer");
    }
  });

  it("treats a failed fetch the same way, with the error as the detail", () => {
    const view = photoView({ status: "error", message: "Could not reach the bearings API." });
    if (view.kind === "note") {
      expect(view.note.text).toBe("Photo lookup not available");
      expect(view.note.detail).toBe("Could not reach the bearings API.");
    }
  });

  it("never renders the same words for 'no photo' and 'not available'", () => {
    const empty = photoView(ready({ photo: null, candidates: 0, usable: 0 }));
    const down = photoView(ready({ photo: { unavailable: true, reason: "x" } }));
    expect(empty.kind).toBe("note");
    expect(down.kind).toBe("note");
    if (empty.kind === "note" && down.kind === "note") {
      expect(empty.note.text).not.toBe(down.note.text);
    }
  });
});

describe("buildPhotoBlock", () => {
  it("goes from looking to a rendered figure in place", () => {
    const block = buildPhotoBlock();
    expect(block.el.querySelector("p")?.textContent).toBe("looking for a photo…");

    block.update(ready());
    const img = block.el.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(LANDMARK_PHOTO.thumb_url);
    // Hotlinked from Wikimedia's own CDN -- never copied to this origin.
    expect(img?.getAttribute("src")).toContain("thumb.wikimedia.org");
    expect(img?.getAttribute("alt")).toBe(displayTitle(LANDMARK_PHOTO.title));
    expect(img?.getAttribute("loading")).toBe("lazy");
    // Aspect reserved before load; the CSS decides the rendered size.
    expect(img?.getAttribute("width")).toBe("480");
    expect(img?.getAttribute("height")).toBe("715");
  });

  it("links the attribution to the Commons file page in a new tab, safely", () => {
    const block = buildPhotoBlock(ready());
    const link = block.el.querySelector("a.buildinginfo__photo-credit") as HTMLAnchorElement;
    expect(link.href).toBe(LANDMARK_PHOTO.description_url);
    expect(link.textContent).toBe("Photo: Bill Abbott, CC BY-SA 2.0, via Wikimedia Commons");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("still renders the credit when there is no file page to link to", () => {
    const block = buildPhotoBlock(ready({ photo: { ...LANDMARK_PHOTO, description_url: null } }));
    expect(block.el.querySelector("a.buildinginfo__photo-credit")).toBeNull();
    expect(block.el.querySelector(".buildinginfo__photo-credit")?.textContent).toContain(
      "Bill Abbott",
    );
  });

  it("carries the file title and the distance on screen, not only in the payload", () => {
    const block = buildPhotoBlock(ready({ photo: NOT_THIS_BUILDING_PHOTO }));
    const text = block.el.textContent ?? "";
    expect(text).toContain("Carroll Street Station Mosaic Tile");
    expect(text).toContain("20 m away");
  });

  it("renders the artist as text, never as markup", () => {
    // Commons' Artist field is HTML and is reduced to plain text server-side
    // (sources/commons.py). Even so, the DOM builder sets textContent, so a
    // string that slipped through cannot become an element.
    const block = buildPhotoBlock(
      ready({ photo: { ...LANDMARK_PHOTO, artist: "<img src=x onerror=alert(1)>" } }),
    );
    const credit = block.el.querySelector(".buildinginfo__photo-credit") as HTMLElement;
    expect(credit.querySelector("img")).toBeNull();
    expect(credit.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("marks each state on the element so a smoke test can read it", () => {
    const block = buildPhotoBlock();
    expect(block.el.querySelector("[data-state='loading']")).not.toBeNull();
    block.update(ready({ photo: null, candidates: 0, usable: 0 }));
    expect(block.el.querySelector("[data-state='empty']")).not.toBeNull();
    block.update(ready());
    expect(block.el.querySelector("[data-state='photo']")).not.toBeNull();
  });
});
