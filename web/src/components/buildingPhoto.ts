// The Commons photo block at the top of the per-building click-card
// (SPEC-building-card-v2.md Part B). One thumbnail hotlinked straight from
// Wikimedia's own CDN when Commons has a file cataloged near this building,
// and a plain sentence saying so when it does not.
//
// Its own module, and its own fetch, for the same two reasons
// buildingRecord.ts is: MapView.tsx imports maplibre-gl and is therefore
// unreachable from a jsdom test, and the states are the thing that needs
// testing. Everything here is a pure function over plain data plus one
// hand-built DOM element.
//
// TWO RULES THIS FILE HOLDS:
//
// 1. "Commons has no photo here" and "we could not ask Commons" are
//    different facts and never render as the same words. Same rule as the
//    record block below it (bearings/buildingrecord.py's module docstring).
//
// 2. **The card never claims the photograph is of this building.** Nothing
//    in the Commons API says what a picture depicts -- coordinates are all
//    there is -- so every hit is introduced by how far away it was cataloged
//    and by its own file title, and the reader judges. Measured live
//    2026-09-07: 360 Smith St, an ordinary Brooklyn rowhouse, returns
//    exactly one file within 40 m and it is a subway mosaic tile 20 m away.

import type { BuildingPhoto, BuildingPhotoResponse } from "../types";
import { isUnavailable } from "../types";

export type PhotoState =
  | { status: "loading" }
  | { status: "ready"; response: BuildingPhotoResponse }
  | { status: "error"; message: string };

export type PhotoNoteTone = "loading" | "empty" | "unavailable";

/** The one-line sentence shown when there is no image to show. */
export interface PhotoNote {
  text: string;
  tone: PhotoNoteTone;
  /** The full reason, rendered as `title` -- the timeout text, or which
   *  radius came back empty. */
  detail?: string;
}

/** What the block renders: either a figure, or a note explaining why not. */
export type PhotoView = { kind: "photo"; photo: BuildingPhoto } | { kind: "note"; note: PhotoNote };

// Commons file titles keep their extension ("....jpg"). The extension is
// storage plumbing, not part of the name a reader is being asked to judge.
export function displayTitle(title: string): string {
  return title.replace(/\.(jpe?g|png|gif|webp|tiff?|svg)$/i, "");
}

/** "20 m away", or `null` when Commons returned no coordinate we could
 *  measure against. Never 0 in that case: a distance nobody measured must
 *  not be printed as though somebody had. */
export function distanceLabel(distanceM: number | null): string | null {
  if (distanceM === null || !Number.isFinite(distanceM)) return null;
  if (distanceM < 1) return "under 1 m away";
  return `${Math.round(distanceM)} m away`;
}

/** "Photo: Bill Abbott, CC BY-SA 2.0, via Wikimedia Commons".
 *
 *  The license is always named -- a file whose license the API does not
 *  carry is dropped server-side rather than shown, so this string can never
 *  be built without one. An unnamed author says so rather than going quiet:
 *  "no author" and "author we did not bother to print" look identical
 *  otherwise. */
export function attributionLine(photo: BuildingPhoto): string {
  const who = photo.artist ?? "author not named on the file page";
  return `Photo: ${who}, ${photo.license}, via Wikimedia Commons`;
}

/** "Cataloged 20 m away — “Carroll Street Station Mosaic Tile”". */
export function provenanceLine(photo: BuildingPhoto): string {
  const where = distanceLabel(photo.distance_m);
  const title = `“${displayTitle(photo.title)}”`;
  return where === null ? `Cataloged nearby — ${title}` : `Cataloged ${where} — ${title}`;
}

export function photoView(state: PhotoState): PhotoView {
  if (state.status === "loading") {
    return { kind: "note", note: { text: "looking for a photo…", tone: "loading" } };
  }
  if (state.status === "error") {
    return {
      kind: "note",
      note: {
        // Not "no photo": a request that failed is not an answer about what
        // Commons holds.
        text: "Photo lookup not available",
        tone: "unavailable",
        detail: state.message,
      },
    };
  }

  const { photo, candidates, radius_m: radius } = state.response;
  if (isUnavailable(photo)) {
    return {
      kind: "note",
      note: { text: "Photo lookup not available", tone: "unavailable", detail: photo.reason },
    };
  }
  if (photo === null) {
    // Commons had files here but none this card can attribute is a
    // different fact from Commons having nothing here, and the server tells
    // them apart, so the card does too.
    if (candidates !== null && candidates > 0) {
      return {
        kind: "note",
        note: {
          text: `${candidates} file${candidates === 1 ? "" : "s"} cataloged within ${radius} m, none this card can credit`,
          tone: "empty",
          detail:
            "A file is only shown when Wikimedia Commons publishes a license name for it, so the photo can carry correct attribution.",
        },
      };
    }
    return {
      kind: "note",
      note: {
        text: `No photo cataloged on Wikimedia Commons within ${radius} m`,
        tone: "empty",
        detail:
          "Commons' coverage of New York buildings is landmark-biased: 56 of 60 randomly-sampled NYC footprints had no file within this radius. This is what the free open data holds, not a gap in the lookup.",
      },
    };
  }
  return { kind: "photo", photo };
}

// No separate sources line for this block, deliberately. Every state that
// makes a claim names Wikimedia Commons inside its own sentence -- the
// attribution line when there is a photo, "No photo cataloged on Wikimedia
// Commons within 40 m" when there is not -- and the "not available" state
// makes no claim about Commons' holdings at all, so it has nothing to cite.
// A fourth line repeating the name would add height to an already-tall card
// and tell the reader nothing. The endpoint still returns `source` for API
// callers; see GET /api/building/{bbl}/photo.

const NOTE_CLASS: Record<PhotoNoteTone, string> = {
  loading: "buildinginfo__photo-note--loading",
  empty: "buildinginfo__photo-note--empty",
  unavailable: "buildinginfo__photo-note--unavailable",
};

/** Builds the block and returns an `update` that re-renders it in place, so
 *  the card can go looking → photo without being torn down and rebuilt
 *  (which on a map marker would visibly re-anchor the popup). Same shape as
 *  buildRecordBlock(). */
export function buildPhotoBlock(initial: PhotoState = { status: "loading" }): {
  el: HTMLDivElement;
  update: (state: PhotoState) => void;
} {
  const el = document.createElement("div");
  el.className = "buildinginfo__photo";

  const update = (state: PhotoState) => {
    el.replaceChildren();
    const view = photoView(state);

    if (view.kind === "note") {
      const p = document.createElement("p");
      p.className = `buildinginfo__photo-note mono ${NOTE_CLASS[view.note.tone]}`;
      p.textContent = view.note.text;
      p.dataset.state = view.note.tone;
      if (view.note.detail) p.title = view.note.detail;
      el.appendChild(p);
      return;
    }

    const { photo } = view;
    const figure = document.createElement("figure");
    figure.className = "buildinginfo__photo-figure";
    figure.dataset.state = "photo";

    const img = document.createElement("img");
    img.className = "buildinginfo__photo-img";
    // Hotlinked straight from Wikimedia's thumbnail CDN, which serves it
    // with `access-control-allow-origin: *`. Nothing is downloaded here and
    // nothing is stored.
    img.src = photo.thumb_url;
    img.alt = displayTitle(photo.title);
    // setAttribute rather than the IDL properties: jsdom does not reflect
    // `img.loading`/`img.decoding` back to attributes, so the test that
    // asserts them would pass in a browser and fail in the suite for a
    // reason that has nothing to do with this card.
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    // The API's thumbwidth/thumbheight are the box that was *requested*, not
    // the bytes served (Wikimedia rounds a request up to a cached bucket:
    // asking for 480 returns a real 500px-wide file). The ratio is right, so
    // these are set only to reserve the correct aspect before the image
    // loads; CSS decides the rendered size.
    if (photo.thumb_width && photo.thumb_height) {
      img.width = photo.thumb_width;
      img.height = photo.thumb_height;
    }
    figure.appendChild(img);

    const caption = document.createElement("figcaption");
    caption.className = "buildinginfo__photo-caption mono";

    const provenance = document.createElement("span");
    provenance.className = "buildinginfo__photo-provenance";
    provenance.textContent = provenanceLine(photo);
    caption.appendChild(provenance);

    const credit = document.createElement(photo.description_url ? "a" : "span");
    credit.className = "buildinginfo__photo-credit";
    credit.textContent = attributionLine(photo);
    if (credit instanceof HTMLAnchorElement && photo.description_url) {
      credit.href = photo.description_url;
      credit.target = "_blank";
      credit.rel = "noopener noreferrer";
    }
    caption.appendChild(credit);

    figure.appendChild(caption);
    el.appendChild(figure);
  };

  update(initial);
  return { el, update };
}
