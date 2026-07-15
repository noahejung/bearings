import type { Profile } from "../types";
import { AmenitiesCard } from "./AmenitiesCard";
import { BuildingCard } from "./BuildingCard";
import { GreenCard } from "./GreenCard";
import { MapView } from "./MapView";
import { QuietCard } from "./QuietCard";
import { SafetyCard } from "./SafetyCard";
import { TransitCard } from "./TransitCard";

export function ReportView({ profile }: { profile: Profile }) {
  return (
    <section className="report" id="report" aria-labelledby="report-heading">
      <header className="report__head">
        <p className="report__kicker mono">The record</p>
        <h2 className="report__title" id="report-heading">
          {profile.address}
        </h2>
      </header>

      <MapView address={profile.address} />

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
