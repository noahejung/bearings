import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Settle } from "./Settle";

// See Settle.tsx's own module comment for the design rationale (keyed
// remount + CSS mount-animation, not a two-layer crossfade) -- these tests
// pin the two properties that rationale depends on: (1) the correct value
// is ALWAYS the only thing in the DOM (no transient duplicate text nodes --
// the exact failure class Wave 1b's own report already hit once), and (2) a
// genuine value change really does remount the node (so the CSS `animation`
// on `.settle` actually replays), while an unrelated re-render with the
// SAME value does NOT (so cell-swap re-renders that happen to produce an
// identical number don't spuriously replay the animation).
describe("Settle", () => {
  it("renders the current value immediately, as a single .settle node", () => {
    render(<Settle settleKey={47}>47</Settle>);
    expect(screen.getAllByText("47")).toHaveLength(1);
    expect(document.querySelector(".settle")).toBeInTheDocument();
  });

  it("never shows two matching text nodes at once, even the instant after a value change (no crossfade duplicate)", () => {
    const { rerender } = render(<Settle settleKey={47}>47</Settle>);
    rerender(<Settle settleKey={6}>6</Settle>);
    // The OLD value is gone immediately -- not lingering, not faded-but-
    // still-queryable. Only the new, correct value is ever in the DOM.
    expect(screen.queryByText("47")).not.toBeInTheDocument();
    expect(screen.getAllByText("6")).toHaveLength(1);
  });

  it("remounts the DOM node when settleKey genuinely changes (so the CSS mount-animation replays)", () => {
    const { container, rerender } = render(<Settle settleKey={47}>47</Settle>);
    const first = container.querySelector(".settle");
    rerender(<Settle settleKey={6}>6</Settle>);
    const second = container.querySelector(".settle");
    expect(second).not.toBe(first);
  });

  it("does NOT remount when settleKey is unchanged (no animation replay for an unrelated re-render)", () => {
    const { container, rerender } = render(<Settle settleKey={47}>47</Settle>);
    const first = container.querySelector(".settle");
    // Same key, different children reference -- e.g. a parent re-rendering
    // for an unrelated reason while the underlying number hasn't moved.
    rerender(
      <Settle settleKey={47}>
        <span>47</span>
      </Settle>,
    );
    const second = container.querySelector(".settle");
    expect(second).toBe(first);
  });

  it("supports an additional className alongside the base .settle class", () => {
    render(
      <Settle settleKey="x" className="tile__value-ordinal">
        th
      </Settle>,
    );
    const el = document.querySelector(".settle");
    expect(el).toHaveClass("settle", "tile__value-ordinal");
  });
});
