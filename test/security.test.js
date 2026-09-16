import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { configureSecurity, profileViewLimiter } from "../security.js";

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("adiciona headers HTTP de seguranca", async () => {
  const app = express();
  configureSecurity(app, {});
  app.get("/", (req, res) => res.json({ ok: true }));
  await withServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("bloqueia abuso da rota de visualizacoes", async () => {
  const app = express();
  app.post("/api/profile-view", profileViewLimiter, (req, res) => {
    res.json({ success: true });
  });
  await withServer(app, async (baseUrl) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/profile-view`, { method: "POST" });
      assert.equal(response.status, 200);
    }
    const blocked = await fetch(`${baseUrl}/api/profile-view`, { method: "POST" });
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get("ratelimit") || "", /limit=3/i);
    assert.deepEqual(await blocked.json(), {
      error: "Muitas requisicoes. Tente novamente mais tarde.",
    });
  });
});
