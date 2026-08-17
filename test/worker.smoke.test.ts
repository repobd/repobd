import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker scaffold", () => {
  it("responds ok on GET /health", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("responds ok with no body on HEAD /health", async () => {
    const res = await SELF.fetch("https://example.com/health", {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("rejects POST /health", async () => {
    const res = await SELF.fetch("https://example.com/health", {
      method: "POST",
    });
    expect(res.status).toBe(405);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await SELF.fetch("https://example.com/unknown");
    expect(res.status).toBe(404);
  });
});
