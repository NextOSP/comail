import { describe, expect, it } from "vitest";
import { pickSignature, signaturesForAccount } from "./signatures";
import type { Settings } from "../ipc/types";

const settings: Pick<Settings, "signatureList" | "signatureDefaults"> = {
  signatureList: [
    { id: "work", accountId: 1, name: "Work", html: "<b>Dean</b>" },
    { id: "brief", accountId: 1, name: "Brief", html: "Dean" },
    { id: "other", accountId: 2, name: "Other", html: "Sent from acct 2" },
  ],
  signatureDefaults: {
    "1": { newId: "work", replyId: "brief" },
    "2": { newId: "other", replyId: null },
  },
};

describe("pickSignature", () => {
  it("uses the new-mail default for new mail", () => {
    expect(pickSignature(settings, 1, "new")?.id).toBe("work");
  });

  it("uses the reply default for reply, reply_all and forward", () => {
    expect(pickSignature(settings, 1, "reply")?.id).toBe("brief");
    expect(pickSignature(settings, 1, "reply_all")?.id).toBe("brief");
    expect(pickSignature(settings, 1, "forward")?.id).toBe("brief");
  });

  it("returns null when the mode default is unset", () => {
    expect(pickSignature(settings, 2, "reply")).toBeNull();
  });

  it("returns null when the account has no defaults", () => {
    expect(pickSignature(settings, 99, "new")).toBeNull();
  });

  it("returns null when the default id points at a missing signature", () => {
    const broken = {
      signatureList: settings.signatureList,
      signatureDefaults: { "1": { newId: "ghost", replyId: null } },
    };
    expect(pickSignature(broken, 1, "new")).toBeNull();
  });

  it("does not cross accounts even if an id matches", () => {
    const crossed = {
      signatureList: settings.signatureList,
      // account 2 points at account 1's signature id
      signatureDefaults: { "2": { newId: "work", replyId: null } },
    };
    expect(pickSignature(crossed, 2, "new")).toBeNull();
  });
});

describe("signaturesForAccount", () => {
  it("returns only the account's signatures, in order", () => {
    expect(signaturesForAccount(settings, 1).map((s) => s.id)).toEqual(["work", "brief"]);
    expect(signaturesForAccount(settings, 2).map((s) => s.id)).toEqual(["other"]);
    expect(signaturesForAccount(settings, 3)).toEqual([]);
  });
});
