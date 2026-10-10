import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../src/proxy";

const req = (auth?: string, path = "/dashboard") => new NextRequest(`http://x${path}`, { headers: auth ? { authorization: auth } : {} });
const basic = (pw: string) => `Basic ${Buffer.from(`anyone:${pw}`).toString("base64")}`;

describe("dashboard proxy (basic auth)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("closed in production when no password is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DASHBOARD_PASSWORD", "");
    expect(proxy(req()).status).toBe(503);
  });
  it("open on a developer machine without a password", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DASHBOARD_PASSWORD", "");
    expect(proxy(req()).status).toBe(200);
  });
  it("401 with a challenge when the password is missing or wrong", () => {
    vi.stubEnv("DASHBOARD_PASSWORD", "hunter2");
    const none = proxy(req());
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/Basic/);
    expect(proxy(req(basic("nope"))).status).toBe(401);
    expect(proxy(req(basic("hunter22"))).status).toBe(401);
  });
  it("passes through with the right password, any username, including a colon in the password", () => {
    vi.stubEnv("DASHBOARD_PASSWORD", "hun:ter2");
    expect(proxy(req(basic("hun:ter2"))).status).toBe(200);
  });

  it("DASHBOARD_PUBLIC=true opens the dashboard without a password, but keeps the simulator closed in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DASHBOARD_PASSWORD", "");
    vi.stubEnv("DASHBOARD_PUBLIC", "true");
    expect(proxy(req()).status).toBe(200);
    expect(proxy(req(undefined, "/dashboard/calls/abc")).status).toBe(200);
    expect(proxy(req(undefined, "/simulator")).status).toBe(404);
    expect(proxy(req(undefined, "/api/simulator/turn")).status).toBe(404);
  });
  it("a password still wins over DASHBOARD_PUBLIC", () => {
    vi.stubEnv("DASHBOARD_PASSWORD", "hunter2");
    vi.stubEnv("DASHBOARD_PUBLIC", "true");
    expect(proxy(req()).status).toBe(401);
  });
});
