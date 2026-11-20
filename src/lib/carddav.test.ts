import { describe, expect, it } from "vitest";
import type { CalendarLogin } from "../ipc/types";
import { hostOf, reusableLogin, sameServer } from "./carddav";

describe("hostOf", () => {
  it("assumes https and lowercases", () => {
    expect(hostOf(" Cloud.Example.org/remote.php/dav ")).toBe("cloud.example.org");
    expect(hostOf("http://dav.example.com:8443/")).toBe("dav.example.com");
    expect(hostOf("")).toBeNull();
    expect(hostOf("http://")).toBeNull();
  });
});

describe("sameServer (mirrors carddav::same_server)", () => {
  it("matches hosts of one provider only", () => {
    expect(sameServer("cloud.example.org", "cloud.example.org")).toBe(true);
    expect(sameServer("carddav.fastmail.com", "caldav.fastmail.com")).toBe(true);
    expect(sameServer("contacts.icloud.com", "p42-caldav.icloud.com")).toBe(true);
    expect(sameServer("dav.example.com", "example.com")).toBe(true);
    expect(sameServer("dav.example.com", "dav.example.net")).toBe(false);
    expect(sameServer("a.com", "b.com")).toBe(false);
    expect(sameServer("192.168.1.10", "192.168.1.11")).toBe(false);
    expect(sameServer("example.com", "com")).toBe(false);
  });
});

describe("reusableLogin", () => {
  const logins: CalendarLogin[] = [
    { accountId: 1, username: "one", hosts: ["caldav.fastmail.com"] },
    { accountId: 2, username: "two", hosts: ["caldav.fastmail.com", "dav.other.net"] },
  ];

  it("prefers the login on the same mail account", () => {
    expect(reusableLogin("carddav.fastmail.com", logins, 2)?.username).toBe("two");
    expect(reusableLogin("https://carddav.fastmail.com/", logins, 3)?.username).toBe("one");
  });

  it("offers nothing for other servers or unusable input", () => {
    expect(reusableLogin("https://dav.example.com", logins, 1)).toBeNull();
    expect(reusableLogin("", logins, 1)).toBeNull();
  });
});
