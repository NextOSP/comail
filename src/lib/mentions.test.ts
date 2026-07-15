import { describe, expect, it } from "vitest";
import { activeMention } from "./mentions";

describe("activeMention", () => {
  it("matches at the start of the string", () => {
    expect(activeMention("@gia")).toEqual({ query: "gia", at: 0 });
  });

  it("matches after whitespace", () => {
    expect(activeMention("hi @gia")).toEqual({ query: "gia", at: 3 });
    expect(activeMention("cc\n@bob")).toEqual({ query: "bob", at: 3 });
  });

  it("treats a bare @ as an empty query", () => {
    expect(activeMention("hey @")).toEqual({ query: "", at: 4 });
    expect(activeMention("@")).toEqual({ query: "", at: 0 });
  });

  it("does not trigger inside an email address", () => {
    expect(activeMention("bd@nextwaves")).toBeNull();
    expect(activeMention("write to bd@nextwaves.com")).toBeNull();
  });

  it("ends the query at a trailing space", () => {
    expect(activeMention("@gia ")).toBeNull();
    expect(activeMention("@gia thinh")).toBeNull();
  });

  it("returns null when there is no @", () => {
    expect(activeMention("just some text")).toBeNull();
    expect(activeMention("")).toBeNull();
  });
});
