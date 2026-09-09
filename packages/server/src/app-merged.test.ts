import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config/loader.js";
import { createApp } from "./app.js";
import { closeDatabase } from "./db/client.js";

describe("createApp Merged Dashboard & Backend (Port 8300)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cliproxy-merged-test-"));
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves dashboard HTML at / and SPA routes, while /v1 goes to API", async () => {
    const config = loadConfig(join(tempDir, "missing.yaml"));
    config.database.path = join(tempDir, "test.db");
    config.auth.enabled = false;
    config.auth.adminToken = "";
    config.auth.initialKeys = [];

    const app = await createApp(config);

    // 1. Root / serves dashboard index.html
    const rootRes = await app.inject({ method: "GET", url: "/" });
    expect(rootRes.statusCode).toBe(200);
    expect(rootRes.headers["content-type"]).toContain("text/html");
    expect(rootRes.body).toContain("<div id=\"root\">");

    // 2. SPA routes like /models or /settings serve dashboard index.html
    const spaRes = await app.inject({ method: "GET", url: "/models" });
    expect(spaRes.statusCode).toBe(200);
    expect(spaRes.headers["content-type"]).toContain("text/html");
    expect(spaRes.body).toContain("<div id=\"root\">");

    // 3. /v1/models routes to the API and returns JSON (not HTML)
    const apiRes = await app.inject({ method: "GET", url: "/v1/models" });
    expect(apiRes.statusCode).toBe(200);
    expect(apiRes.headers["content-type"]).toContain("application/json");
    const apiBody = JSON.parse(apiRes.body);
    expect(apiBody).toHaveProperty("object", "list");
    expect(Array.isArray(apiBody.data)).toBe(true);

    // 4. Non-existent /v1/* route returns 404 JSON error (not HTML)
    const api404 = await app.inject({ method: "GET", url: "/v1/nonexistent" });
    expect(api404.statusCode).toBe(404);
    expect(api404.headers["content-type"]).toContain("application/json");
    const errBody = JSON.parse(api404.body);
    expect(errBody.error).toBeDefined();

    // 5. /health works
    const healthRes = await app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.headers["content-type"]).toContain("application/json");

    // 6. /admin/server-info returns 8300 for both serverPort and dashboardPort
    const serverInfoRes = await app.inject({ method: "GET", url: "/admin/server-info" });
    expect(serverInfoRes.statusCode).toBe(200);
    const info = JSON.parse(serverInfoRes.body);
    expect(info.serverPort).toBe(8300);
    expect(info.dashboardPort).toBe(8300);
    expect(info.authEnabled).toBe(false);

    await app.close();
  }, 15000);

  it("enforces /v1 auth when auth.enabled is true without blocking dashboard UI", async () => {
    const config = loadConfig(join(tempDir, "missing.yaml"));
    config.database.path = join(tempDir, "test.db");
    config.auth.enabled = true;
    config.auth.adminToken = "admin-secret-token";
    config.auth.initialKeys = [{ name: "test", key: "sk-proxy-test-key-12345" }];

    const app = await createApp(config);

    // Dashboard UI is accessible without credentials even when auth is enabled
    const rootRes = await app.inject({ method: "GET", url: "/" });
    expect(rootRes.statusCode).toBe(200);
    expect(rootRes.headers["content-type"]).toContain("text/html");

    // /v1/models requires API key when auth is enabled
    const unauthApi = await app.inject({ method: "GET", url: "/v1/models" });
    expect(unauthApi.statusCode).toBe(401);

    // /v1/models with valid API key succeeds
    const authApi = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer sk-proxy-test-key-12345" },
    });
    expect(authApi.statusCode).toBe(200);

    // /admin/server-info is accessible to let dashboard check auth status
    const serverInfoRes = await app.inject({ method: "GET", url: "/admin/server-info" });
    expect(serverInfoRes.statusCode).toBe(200);
    const info = JSON.parse(serverInfoRes.body);
    expect(info.authEnabled).toBe(true);

    await app.close();
  }, 15000);
});
