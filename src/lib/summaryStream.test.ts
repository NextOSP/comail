import { describe, expect, it } from "vitest";
import { parsePartialAiSummary } from "./summaryStream";

const COMPLETE = JSON.stringify({
  timeline: [
    { actor: "Ana", event: "requested a review" },
    { actor: "You", event: "confirmed availability" },
  ],
  keyPoints: ["Review is on Friday", "Room 4B"],
  nextAction: "Attend the review.",
  proposedReply: "See you there.",
  calendarSuggestion: {
    title: "Design review",
    start: "2026-07-17T10:00:00+07:00",
    end: "2026-07-17T10:30:00+07:00",
    allDay: false,
    location: "Room 4B",
    description: "Review the final design.",
  },
});

describe("parsePartialAiSummary", () => {
  it("reveals completed timeline entries before the response finishes", () => {
    const cut = COMPLETE.indexOf('},{"actor":"You"') + 1;
    const partial = parsePartialAiSummary(COMPLETE.slice(0, cut));
    expect(partial?.timeline).toEqual([
      { actor: "Ana", event: "requested a review" },
    ]);
    expect(partial?.keyPoints).toEqual([]);
  });

  it("reveals key points one at a time and withholds an incomplete string", () => {
    const cut = COMPLETE.indexOf(',"Room 4B"');
    const partial = parsePartialAiSummary(COMPLETE.slice(0, cut + 7));
    expect(partial?.keyPoints).toEqual(["Review is on Friday"]);
  });

  it("returns the complete summary and calendar suggestion", () => {
    expect(parsePartialAiSummary(COMPLETE)).toMatchObject({
      nextAction: "Attend the review.",
      proposedReply: "See you there.",
      calendarSuggestion: {
        title: "Design review",
        location: "Room 4B",
      },
    });
  });
});
