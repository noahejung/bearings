// Real MTA line colors (from the dispatch spec) plus PATH and the shuttle, which the
// spec left unspecified but the live API returns ("S" at 1 Times Square; verified
// 2026-07-13). Falls back to a neutral ink tag for anything unrecognized so a route
// code never renders unstyled or blank -- express variants like "FX" / "6X" (also seen
// live) collapse to their local's color via the trailing-X strip below.
const ROUTE_COLORS: Record<string, string> = {
  A: "#0039A6",
  C: "#0039A6",
  E: "#0039A6",
  B: "#FF6319",
  D: "#FF6319",
  F: "#FF6319",
  M: "#FF6319",
  N: "#FCCC0A",
  Q: "#FCCC0A",
  R: "#FCCC0A",
  W: "#FCCC0A",
  "1": "#EE352E",
  "2": "#EE352E",
  "3": "#EE352E",
  "4": "#00933C",
  "5": "#00933C",
  "6": "#00933C",
  "7": "#B933AD",
  G: "#6CBE45",
  J: "#996633",
  Z: "#996633",
  L: "#A7A9AC",
  S: "#808183",
  PATH: "#009CDE",
};

// The yellow, lime, and PATH-blue swatches are light enough that white text fails
// contrast -- MTA signage itself uses black text on N/Q/R/W and G bullets.
const DARK_TEXT_ROUTES = new Set(["N", "Q", "R", "W", "G"]);

const FALLBACK_COLOR = "#5B5648";

// Exported so the map (MapView.tsx) can build plain-DOM station markers in
// the same real MTA/PATH wayfinding colours without duplicating this table
// -- one source of truth for "what colour is the B train", not two that
// could drift apart.
export function colorFor(route: string): string {
  if (route in ROUTE_COLORS) return ROUTE_COLORS[route];
  const local = route.replace(/X$/, ""); // FX -> F, 6X -> 6 (express variants)
  return ROUTE_COLORS[local] ?? FALLBACK_COLOR;
}

export function isDarkTextRoute(route: string): boolean {
  return DARK_TEXT_ROUTES.has(route.replace(/X$/, ""));
}

export function RouteBullet({ route }: { route: string }) {
  const bg = colorFor(route);
  const dark = DARK_TEXT_ROUTES.has(route.replace(/X$/, ""));
  // "PATH" is four characters -- a circle bullet like the subway's single-character
  // ones would either clip it or force a huge circle. Render it as a pill instead.
  const wide = route.length > 2;
  return (
    <span
      className={["bullet", dark && "bullet--dark-text", wide && "bullet--wide"]
        .filter(Boolean)
        .join(" ")}
      style={{ backgroundColor: bg }}
      title={route === "PATH" ? "PATH" : `${route} train`}
    >
      {route}
    </span>
  );
}

export function RouteBullets({ routes }: { routes: string[] }) {
  if (routes.length === 0) return null;
  return (
    <span className="bullets">
      {routes.map((r) => (
        <RouteBullet route={r} key={r} />
      ))}
    </span>
  );
}
