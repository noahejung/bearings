// Verified live against the running API on 2026-07-13 (see the dispatch report for the
// raw curl output). Each address was chosen to show the tool doing something different --
// this is not a random sample, it's a deliberate spread:
//
//   Sedgwick Ave  -- the dramatic case. 1,410 noise complaints, 72 open Class C
//                    ("immediately hazardous") HPD violations, a 10-minute walk to the
//                    nearest train. Paired with EXAMPLE_LISTING_TEXT below, which is
//                    genuinely contradicted on four separate claims -- not cherry-picked
//                    copy, an actual listing-style paragraph run through the real checker.
//   5th Avenue    -- dense Midtown. Huge amenity counts, huge noise count too (the
//                    "quiet" claim would fail here as well), but genuinely tree-lined
//                    (277 street trees) -- shows the tool isn't a blanket "everything's
//                    false" machine.
//   MetroTech     -- Downtown Brooklyn tower. Different era (built 1996 -- pluto.py's
//                    own _era() cutoff puts this in the "postwar" bucket, not "modern"
//                    (that starts at 2000), no strong rent-stabilisation signal either
//                    way), and a good spread across all four commute anchors.
//   Netherland Ave-- Riverdale. The leafiest of the four (778 street trees) and the
//                    farthest from the anchors (45-62 minutes) -- the "quiet, far,
//                    green" archetype for contrast against Midtown.
export interface ExampleAddress {
  address: string;
  label: string;
  sublabel: string;
  /** Shown as a small badge -- this is the one calibrated to pair with EXAMPLE_LISTING_TEXT. */
  featured?: boolean;
}

export const EXAMPLE_ADDRESSES: ExampleAddress[] = [
  {
    address: "1520 Sedgwick Ave, Bronx",
    label: "Sedgwick Ave",
    sublabel: "The Bronx — birthplace of hip-hop",
    featured: true,
  },
  {
    address: "350 5th Ave, Manhattan",
    label: "5th Avenue",
    sublabel: "Midtown Manhattan",
  },
  {
    address: "9 Metrotech Center, Brooklyn",
    label: "MetroTech",
    sublabel: "Downtown Brooklyn",
  },
  {
    address: "3220 Netherland Ave, Bronx",
    label: "Netherland Ave",
    sublabel: "Riverdale, the Bronx",
  },
];

export const EXAMPLE_LISTING_ADDRESS = "1520 Sedgwick Ave, Bronx";

export const EXAMPLE_LISTING_TEXT =
  "A quiet, tree-lined block, steps from the subway. This sun-drenched, newly renovated, " +
  "well-maintained 2BR is close to everything -- a true gem in a prime location. Won't last!";
