import type { Profile } from "../types";
import { AmenitiesCard } from "./AmenitiesCard";
import { BuildingCard } from "./BuildingCard";
import { GreenCard } from "./GreenCard";
import { QuietCard } from "./QuietCard";
import { SafetyCard } from "./SafetyCard";
import { TransitCard } from "./TransitCard";

export function ReportView({ profile }: { profile: Profile }) {
  return (
    <section className="report-view" id="report" aria-labelledby="report-heading">
      <header className="section-header">
        <p className="kicker">The record</p>
        <h2 className="section-header__title" id="report-heading">
          {profile.address}
        </h2>
        <p className="section-header__meta">
          {profile.location.lat.toFixed(5)}, {profile.location.lng.toFixed(5)} · H3 cell{" "}
          {profile.cell}
          {profile.location.bbl && <> · BBL {profile.location.bbl}</>}
        </p>
      </header>

      <div className="report-grid">
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
