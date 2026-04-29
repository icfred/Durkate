import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("buildApp", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close) {
      await close();
      close = null;
    }
  });

  it("GET /health returns 200 { ok: true }", async () => {
    const { app } = await buildApp();
    close = () => app.close();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
