import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SyncControl } from "./SyncControl";

function render(syncing: boolean) {
  return renderToStaticMarkup(
    createElement(SyncControl, {
      syncing,
      statusLabel: "Checking mail",
      buttonLabel: "Check mail",
      onSync: () => {},
    }),
  );
}

const spinners = (html: string) => html.match(/co-spinner/g)?.length ?? 0;

describe("SyncControl", () => {
  it("shows exactly one spinner (on the button) next to the status text while syncing", () => {
    const html = render(true);
    expect(spinners(html)).toBe(1);
    expect(html).toContain("Checking mail");
    expect(html).toMatch(/<button[^>]*aria-busy="true"[^>]*disabled/);
  });

  it("shows no spinner and no status text when idle", () => {
    const html = render(false);
    expect(spinners(html)).toBe(0);
    expect(html).not.toContain("Checking mail");
    expect(html).not.toContain("aria-busy");
  });
});
