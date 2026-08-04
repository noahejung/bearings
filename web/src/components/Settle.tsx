import type { ReactNode } from "react";

// Wraps a headline number (a tile's value, a percentile) so it "settles"
// (a brief opacity/position ease-in, ~200ms -- index.css's --motion-base)
// whenever the REAL underlying value changes -- SPEC "data-viz animations
// wave" (2026-08-03) items 2/4: "the headline numerals settle... same
// settle idiom as tile values." Stamps/labels do NOT get this treatment
// (the same spec's own item 2, second sentence) -- never wrap one here.
//
// DESIGN DECISION, worth reading before reusing this elsewhere: this is a
// single-node "fade the new, already-correct value in from a dimmed state"
// (a keyed remount + a CSS `animation` that plays automatically on mount),
// not a true two-layer crossfade (old value fading out while a new one
// fades in on top of it, simultaneously). Three real reasons, not just
// "simpler":
//   1. COMPREHENSION FIRST (the spec's own binding rule: "no animation
//      that delays the answer"). The correct final text is in the DOM
//      the instant the value changes -- only its opacity is still easing
//      in. A two-layer crossfade, by construction, keeps the OLD (now
//      wrong) value fully legible on screen for part of the transition.
//   2. NEVER DISPLAY A NUMBER THE DATA DOESN'T SUPPORT (this project's own
//      rule, SPEC.md's "Rejected, and why" + this repo's own None-vs-0
//      discipline). A count-up (interpolating digit-by-digit between old
//      and new) would paint a sequence of numbers nobody ever computed.
//      This component never does that -- the text is always either the
//      previous real value or the next real value, never an invented one
//      in between.
//   3. TEST SAFETY, proven the hard way on this project before (Wave 1b's
//      own report: a duplicated text node broke a single-match `getByText`
//      query). A true two-layer crossfade means TWO live DOM nodes with
//      overlapping/matching text exist simultaneously for the transition's
//      duration -- exactly the failure class Wave 1b hit. Because React's
//      key-based reconciliation unmounts the old node and mounts the new
//      one in the SAME commit, there is only ever one `.settle` node for
//      a given call site at any instant -- a query fired the instant after
//      a value change sees the new (correct) node, immediately, with no
//      transient duplicate.
//
// INTERRUPTIBLE BY CONSTRUCTION: if `settleKey` changes again before the
// previous change's animation finishes, React unmounts the mid-animation
// node and mounts a fresh one for the newest key -- the CSS animation
// simply restarts on the new node. Nothing queues, nothing stutters,
// because there is fundamentally only ever one node to animate.
export function Settle({
  settleKey,
  children,
  className,
}: {
  settleKey: string | number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span key={settleKey} className={className ? `settle ${className}` : "settle"}>
      {children}
    </span>
  );
}
