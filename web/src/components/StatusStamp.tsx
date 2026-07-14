import type { ClaimStatus } from "../types";
import { Stamp, stampLabel, type StampVariant } from "./Stamp";

// The API's claim status enum is a stable contract (factcheck.py: supported
// / contradicted / unfalsifiable / no_data) -- this is the one place that
// glosses it onto the shared Stamp vocabulary for display. The underlying
// `status` string itself is never renamed anywhere else in the app.
const STATUS_TO_VARIANT: Record<ClaimStatus, StampVariant> = {
  supported: "confirmed",
  contradicted: "contradicted",
  unfalsifiable: "unverifiable",
  no_data: "no_data",
};

export function statusLabel(status: ClaimStatus): string {
  return stampLabel(STATUS_TO_VARIANT[status]);
}

export function StatusStamp({ status }: { status: ClaimStatus }) {
  return <Stamp variant={STATUS_TO_VARIANT[status]} />;
}
