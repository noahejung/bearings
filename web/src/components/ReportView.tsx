import type { Profile } from "../types";
import { AmenitiesCard } from "./AmenitiesCard";
import { BuildingCard } from "./BuildingCard";
import { GreenCard } from "./GreenCard";
import { QuietCard } from "./QuietCard";
import { SafetyCard } from "./SafetyCard";
import { TransitCard } from "./TransitCard";

// NOTE (SPEC-precompute-v2.md Phase 2, 2026-07-15): App.tsx no longer
// renders this component -- the primary report now always loads from the
// fast, precomputed GET /api/cell/{h3} (see CellReportView.tsx), not the
// live, building-level GET /api/profile this component's cards were built
// for. Kept intact, still real and still tested (BuildingCard.test.tsx,
// SourceCitations.test.tsx), for whenever a future phase wires true
// per-building detail back in on top of the fast block-level report (the
// dispatch's own "Keep /api/profile callable" note) -- MapView now mounts
// at App's top level instead of nested here, since it must be visible
// before any report (building- or block-level) has ever loaded.
export function ReportView({ profile }: { profile: Profile }) {
  return (
    <section className="report" id="report" aria-labelledby="report-heading">
      <header className="report__head">
        <p className="report__kicker mono">The record</p>
        <h2 className="report__title" id="report-heading">
          {profile.address}
        </h2>
      </header>

      <div className="fields">
        <TransitCard transit={profile.transit} />
        <AmenitiesCard amenities={profile.amenities} />
        <SafetyCard safety={profile.safety} />
        <QuietCard quiet={profile.quiet} />
        <GreenCard green={profile.green} />
        <BuildingCard building={profile.building} />
      </div>
    </section>
  );
}
