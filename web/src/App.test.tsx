import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

// A real integration test, not just a compile check: mounts the whole app,
// drives a real address submission through the real fetch call sites, and
// asserts that every restyled field actually renders -- the tDR restyle
// touched App.tsx, Header, AddressSearch, ReportView, all six report
// fields, MapView, and the fact-check view in one pass, and a green
// `tsc -b` proves the types line up, not that the tree renders without
// throwing at runtime (a bad prop shape, a missing null guard, or a
// crashed child can still pass typecheck if a type lied).
//
// MapView.tsx now drives a real maplibre-gl WebGL map, which jsdom cannot
// render (no WebGL context) -- this is a rendering-engine limitation, not
// a data-source mock, so it doesn't conflict with this repo's "no mocking"
// rule (that rule is about live data, not about jsdom's inability to run a
// GPU). The fake below implements just enough of the real Map/Marker
// surface (DOM attachment, an async "load" event, GeoJSON source storage)
// that this test still exercises MapView's real effect logic and real
// fetched data reaching real DOM nodes -- it does not fake away the thing
// under test, only the WebGL renderer jsdom structurally cannot provide.
vi.mock("maplibre-gl", () => {
  class FakeMarker {
    element: HTMLElement;
    map: FakeMap | null = null;
    constructor(opts: { element: HTMLElement }) {
      this.element = opts.element;
    }
    setLngLat() {
      return this;
    }
    addTo(map: FakeMap) {
      this.map = map;
      map._container?.appendChild(this.element);
      return this;
    }
    remove() {
      this.element.remove();
      return this;
    }
    getElement() {
      return this.element;
    }
  }

  class FakeGeoJSONSource {
    data: unknown;
    constructor(data: unknown) {
      this.data = data;
    }
    setData(d: unknown) {
      this.data = d;
      return this;
    }
  }

  class FakeMap {
    _container: HTMLElement | null;
    _sources = new Map<string, FakeGeoJSONSource>();
    _handlers = new Map<string, (...args: never[]) => void>();
    constructor(opts: { container: HTMLElement }) {
      this._container = opts.container;
      // Real MapLibre fires "load" asynchronously once style/tile
      // resources resolve -- a microtask mirrors that ordering closely
      // enough for React's effects to see it as a real state transition.
      queueMicrotask(() => this._handlers.get("load")?.());
    }
    addControl() {
      return this;
    }
    on(event: string, a: unknown, b?: unknown) {
      if (typeof b === "function") {
        this._handlers.set(`${event}:${a as string}`, b as () => void);
      } else {
        this._handlers.set(event, a as () => void);
      }
      return this;
    }
    off() {
      return this;
    }
    remove() {
      return this;
    }
    addSource(id: string, opts: { data: unknown }) {
      this._sources.set(id, new FakeGeoJSONSource(opts.data));
      return this;
    }
    getSource(id: string) {
      return this._sources.get(id);
    }
    addLayer() {
      return this;
    }
    setLayoutProperty() {
      return this;
    }
    setPaintProperty() {
      return this;
    }
    fitBounds() {
      return this;
    }
    getBounds() {
      return { contains: () => true };
    }
    getCenter() {
      return { lat: 40.7484, lng: -73.9857 };
    }
    getZoom() {
      return 14;
    }
    getCanvas() {
      return { style: {} };
    }
  }

  return {
    default: {
      Map: FakeMap,
      Marker: FakeMarker,
      NavigationControl: class {},
      addProtocol: vi.fn(),
      removeProtocol: vi.fn(),
    },
  };
});

vi.mock("pmtiles", () => ({
  Protocol: class {
    tile() {
      /* never actually invoked -- addProtocol itself is mocked above */
    }
  },
}));

const ADDRESS = "350 5th Ave, Manhattan";

const PROFILE = {
  address: "350 5th Ave, Manhattan, NY",
  cell: "892a100d2d7ffff",
  location: { lat: 40.7484, lng: -73.9857, bbl: "1008350041" },
  transit: {
    nearest_stations: [{ name: "34 St-Herald Sq", routes: ["B", "D", "F", "M"], walk_minutes: 4 }],
    to_anchors: { midtown: 9, wtc: 21, downtown_brooklyn: 27, newport_path: 33 },
    caveat: "In-vehicle time plus a nominal transfer penalty.",
    source: { name: "MTA GTFS + PATH GTFS", url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip" },
  },
  amenities: {
    counts: { grocery: 6, cafe: 21, bar: 9, restaurant: 74, pharmacy: 4, gym: 3, park: 1, laundry: 2 },
    source: { name: "Overture Maps Places", url: "https://docs.overturemaps.org/guides/places/" },
  },
  safety: {
    precinct: 14,
    week_ending: "7/5/2026",
    robbery_ytd: 12,
    robbery_pct: -3.2,
    felony_assault_ytd: 8,
    felony_assault_pct: 1.1,
    total_ytd: 200,
    total_pct: 0.4,
    crime_percentile: 91.7,
    crime_caveat:
      "Shown as this precinct's percentile position among all NYC precincts, ranked by raw year-to-date major-crime count -- not a per-resident rate.",
    source: { name: "NYPD CompStat", url: "https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page" },
  },
  quiet: {
    noise_complaints_12mo: 1297,
    source: { name: "NYC 311", url: "https://data.cityofnewyork.us/d/erm2-nwe9" },
  },
  green: {
    street_trees_nearby: 277,
    source: { name: "NYC Street Tree Census", url: "https://data.cityofnewyork.us/d/uvpi-gqnh" },
  },
  building: {
    year_built: 1931,
    era: "prewar",
    era_note: "Pre-war walk-up stock often carries rent-stabilised units.",
    hpd_open_violations: { class_a: 1, class_b: 0, class_c: 2 },
    source: { name: "NYC PLUTO + HPD", url: "https://data.cityofnewyork.us/d/wvxf-dwi5" },
  },
};

const MAP_GEOMETRY = {
  subject: { lat: 40.7484, lng: -73.9857, bbl: "1008350041", cell: "892a100d2d7ffff" },
  bbox: { south: 40.7421, north: 40.7547, west: -73.9957, east: -73.9757 },
  buildings: [
    {
      bbl: "1008350041",
      coords: [
        [40.7482, -73.9859],
        [40.7486, -73.9859],
        [40.7486, -73.9855],
        [40.7482, -73.9855],
        [40.7482, -73.9859],
      ],
    },
  ],
  streets: [{ physicalid: "12345", coords: [[40.748, -73.986], [40.749, -73.985]], rank: 2 }],
  subway_lines: [
    { coords: [[40.748, -73.986], [40.75, -73.984]], route: "B/D/F/M" },
  ],
  stations: [{ name: "34 St-Herald Sq", lat: 40.7497, lng: -73.9877, routes: ["B", "D", "F", "M"] }],
  cells: Array.from({ length: 37 }, (_, i) => ({
    h3: i === 0 ? "892a100d2d7ffff" : `892a100d2d7ff${i.toString().padStart(2, "0")}`,
    noise: i === 0 ? 42 : i,
    amenities: i === 0 ? 12 : i % 5,
    trees: i === 0 ? 8 : i % 4,
    building_age_years: i === 3 ? null : 1930 + i,
    transit_access: i === 0 ? 3 : i % 2,
  })),
  basemap_note: "Every layer is real, drawn from public records...",
  sources: {
    basemap: { name: "Protomaps Basemap (OpenStreetMap + Natural Earth)", url: "https://docs.protomaps.com/basemaps/downloads" },
    subway: { name: "MTA GTFS + PATH GTFS", url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip" },
    cells: { name: "NYC 311", url: "https://data.cityofnewyork.us/d/erm2-nwe9" },
    buildings: { name: "NYC Building Footprints", url: "https://data.cityofnewyork.us/d/5zhs-2jue" },
    streets: { name: "NYC Street Centerline (CSCL)", url: "https://data.cityofnewyork.us/d/inkn-q76z" },
    amenities: { name: "Overture Maps Places", url: "https://docs.overturemaps.org/guides/places/" },
    trees: { name: "NYC Street Tree Census", url: "https://data.cityofnewyork.us/d/uvpi-gqnh" },
    building_age: { name: "NYC PLUTO", url: "https://data.cityofnewyork.us/d/64uk-42ks" },
    transit_access: { name: "MTA GTFS + PATH GTFS", url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip" },
  },
};

const CITYWIDE = {
  neighborhoods: [
    { nta2020: "MN0502", name: "Chelsea-Hudson Yards", borough: "Manhattan", lat: 40.7508, lng: -73.9975 },
  ],
  precincts: [
    {
      precinct: 14,
      lat: 40.7548,
      lng: -73.9925,
      geometry: { type: "Polygon", coordinates: [[[-74.0, 40.75], [-73.99, 40.75], [-73.99, 40.76], [-74.0, 40.76], [-74.0, 40.75]]] },
      crime: { week_ending: "7/5/2026", robbery_ytd: 12, felony_assault_ytd: 8, total_ytd: 200, crime_percentile: 91.7 },
    },
  ],
  neighborhoods_source: { name: "NYC Neighborhood Tabulation Areas (NTAs)", url: "https://data.cityofnewyork.us/d/9nt8-h7nd" },
  precincts_source: { name: "NYPD Police Precincts", url: "https://data.cityofnewyork.us/d/y76i-bdw7" },
  crime_source: { name: "NYPD CompStat", url: "https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page" },
  crime_caveat:
    "Shown as this precinct's percentile position among all NYC precincts, ranked by raw year-to-date major-crime count -- not a per-resident rate.",
};

beforeEach(() => {
  // jsdom doesn't implement these -- App.tsx calls both on a successful load.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/profile")) {
        return Promise.resolve(new Response(JSON.stringify(PROFILE), { status: 200 }));
      }
      if (url.includes("/api/map")) {
        return Promise.resolve(new Response(JSON.stringify(MAP_GEOMETRY), { status: 200 }));
      }
      if (url.includes("/api/citywide")) {
        return Promise.resolve(new Response(JSON.stringify(CITYWIDE), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App (full mount)", () => {
  it("renders the masthead, submits an address, and renders every real report field", async () => {
    render(<App />);

    expect(screen.getByText("Bearings")).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/5TH AVE/i);
    fireEvent.change(input, { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));

    // The address now legitimately appears twice once a profile loads --
    // once in the header band (VISUAL.md §1's 2026-07-15 newcomer addendum
    // replaced the internal H3 identifier there with the address itself)
    // and once as the report's own heading -- so this asserts on the
    // heading specifically rather than plain text, which would now match
    // both nodes.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: PROFILE.address })).toBeInTheDocument(),
    );

    // The six real report fields, named by their own heading -- VISUAL.md
    // §1's NO-LARP rule cut the invented "§0X·XXX" section codes, so the
    // metric's own label is the only thing that identifies it now.
    expect(screen.getByRole("heading", { name: /getting around/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /within a 10-minute walk/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /crime near here/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /noise complaints/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /living street trees/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /building age and violations/i })).toBeInTheDocument();

    // Real values actually reached the DOM, not just the field chrome.
    expect(screen.getByText("34 St-Herald Sq")).toBeInTheDocument();
    expect(screen.getByText("1,297")).toBeInTheDocument(); // noise complaints, tabular-formatted
    expect(screen.getByText("1931")).toBeInTheDocument();

    // Crime is relative-to-NYC, not an absolute number on its own
    // (VISUAL.md §5, 2026-07-15): the safety card's headline is the
    // citywide framing, and the raw count (200) survives only as a
    // secondary line in the table below it.
    expect(screen.getByText(/More major crimes reported than most of New York City/i)).toBeInTheDocument();
    expect(screen.getByText(/92nd out of 100/i)).toBeInTheDocument();

    // The map field rendered with the real fetched geometry, not stuck loading
    // -- MapView.tsx now drives a real maplibre-gl map (mocked above only
    // because jsdom has no WebGL), and its station markers carry the real
    // station name fetched from /api/map as a real DOM `title` attribute.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /the neighbourhood, navigable/i })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByTitle(/34 St-Herald Sq/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/Navigable map of New York City/i)).toBeInTheDocument();

    // The metric dropdown is real UI, off by default (VISUAL.md §5's
    // metric-dropdown revision -- replaces the old hardcoded noise/crime
    // toggle buttons). Every "ship"/"proxy" metric is selectable; every
    // "disabled" one (flood, rodents, heat, bedbugs) is a real, greyed,
    // non-selectable <option> with its own reason -- never silently
    // omitted from the picker.
    const metricSelect = screen.getByLabelText(/shade the map by/i) as HTMLSelectElement;
    expect(metricSelect.value).toBe("none");
    const options = Array.from(metricSelect.options);
    expect(options.find((o) => /noise complaints/i.test(o.text))?.disabled).toBe(false);
    const floodOption = options.find((o) => /flood zone/i.test(o.text));
    expect(floodOption?.disabled).toBe(true);
    expect(floodOption?.title).toMatch(/one address at a time/i);
    const rodentOption = options.find((o) => /rodent/i.test(o.text));
    expect(rodentOption?.disabled).toBe(true);

    // The raw H3 index string is gone from both the header band and the
    // map's hover readout (VISUAL.md §1's 2026-07-15 newcomer addendum --
    // the header now shows the loaded address, not an internal cell ID).
    const readoutPanel = screen.getByText(/What.s here/i).closest(".readout");
    expect(readoutPanel?.textContent).not.toMatch(/892a/);

    // The fact-check section is present and wired to the same address.
    expect(screen.getByRole("heading", { name: /check a listing/i })).toBeInTheDocument();

    // NO-LARP regression (VISUAL.md §1, 2026-07-14): the fictional bureau,
    // catalogue codes, and refusals line must never come back.
    expect(screen.queryByText(/Peoples Bureau/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/BRG—/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NO LISTINGS/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/§0/)).not.toBeInTheDocument();
  });

  it("renders a real NO DATA stamp, never a guessed number, when a field is genuinely null", async () => {
    const noRecordProfile = {
      ...PROFILE,
      location: { ...PROFILE.location, bbl: null },
      building: {
        year_built: null,
        era: null,
        era_note: null,
        hpd_open_violations: null,
        source: PROFILE.building.source,
      },
      safety: {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/profile")) {
          return Promise.resolve(new Response(JSON.stringify(noRecordProfile), { status: 200 }));
        }
        if (url.includes("/api/map")) {
          return Promise.resolve(new Response(JSON.stringify(MAP_GEOMETRY), { status: 200 }));
        }
        if (url.includes("/api/citywide")) {
          return Promise.resolve(new Response(JSON.stringify(CITYWIDE), { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/5TH AVE/i), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));

    // The address now legitimately appears twice once a profile loads --
    // once in the header band (VISUAL.md §1's 2026-07-15 newcomer addendum
    // replaced the internal H3 identifier there with the address itself)
    // and once as the report's own heading -- so this asserts on the
    // heading specifically rather than plain text, which would now match
    // both nodes.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: PROFILE.address })).toBeInTheDocument(),
    );

    expect(screen.getByText(/We don.t have property records/i)).toBeInTheDocument();
    expect(screen.getByText(/We don.t have crime data/i)).toBeInTheDocument();
    // At least one real "NO DATA" stamp rendered -- the dashed steel gap,
    // never a silently-guessed zero.
    expect(screen.getAllByText("NO DATA").length).toBeGreaterThan(0);
  });
});
