
import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";

const { Pool } = pg;

const app = Fastify({ logger: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 10000
});

pool.on("error", (error) => {
  app.log.error({ error }, "Unexpected idle PostgreSQL connection error");
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function requireShopifySession(request, reply) {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  const authorization = request.headers.authorization;

  if (!apiKey || !apiSecret) {
    return reply.code(503).send({
      error: "Shopify authentication is not configured"
    });
  }

  if (!authorization?.startsWith("Bearer ")) {
    return reply
      .header("X-Shopify-Retry-Invalid-Session-Request", "1")
      .code(401)
      .send({ error: "Unauthorized" });
  }

  try {
    const token = authorization.slice(7);
    const [header, payload, signature] = token.split(".");

    if (!header || !payload || !signature) {
      throw new Error("Invalid token");
    }

    const expected = createHmac("sha256", apiSecret)
      .update(`${header}.${payload}`)
      .digest();
    const received = Buffer.from(signature, "base64url");

    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new Error("Invalid signature");
    }

    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    const shop = new URL(claims.dest).hostname.toLowerCase();
    const configuredShop = process.env.SHOPIFY_SHOP_DOMAIN
      ?.trim()
      .toLowerCase();

    if (
      !audiences.includes(apiKey) ||
      !claims.exp ||
      claims.exp < now ||
      (claims.nbf && claims.nbf > now) ||
      !shop.endsWith(".myshopify.com") ||
      (configuredShop && shop !== configuredShop)
    ) {
      throw new Error("Invalid token claims");
    }

    request.shopifySession = { shop, userId: claims.sub || null };
  } catch {
    return reply
      .header("X-Shopify-Retry-Invalid-Session-Request", "1")
      .code(401)
      .send({ error: "Unauthorized" });
  }
}

app.addHook("onSend", async (_request, reply, payload) => {
  reply.header(
    "Content-Security-Policy",
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com"
  );
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("X-Content-Type-Options", "nosniff");
  return payload;
});

app.get("/", async (_request, reply) => {
  const apiKey = escapeHtml(process.env.SHOPIFY_API_KEY || "");

  return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="shopify-api-key" content="${apiKey}">
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <title>KVB Labels</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f1f1f1; color: #202223; font-family: Inter, Arial, sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 24px 48px; }
    h1 { margin: 0; font-size: 26px; }
    .subtitle { margin: 6px 0 22px; color: #616161; }
    .card { padding: 22px; border: 1px solid #d8d8d8; border-radius: 12px; background: white; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    .status { display: inline-flex; align-items: center; gap: 8px; margin-top: 14px; font-weight: 650; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #8c9196; }
    .ready .dot { background: #29845a; }
    .error .dot { background: #d72c0d; }
  </style>
</head>
<body>
  <main>
    <h1>KVB Labels</h1>
    <p class="subtitle">Dispatch labels and Shopify fulfilment</p>
    <section class="card">
      <strong>Application setup</strong>
      <p>The application is running. Label queues and dispatch controls will be added next.</p>
      <div id="status" class="status"><span class="dot"></span><span>Checking database…</span></div>
    </section>
  </main>
  <script>
    async function loadStatus() {
      const status = document.getElementById("status");

      try {
        const token = await shopify.idToken();
        const response = await fetch("/api/status", {
          headers: { Authorization: "Bearer " + token }
        });
        const body = await response.json();

        if (!response.ok || body.database !== "connected") {
          throw new Error(body.error || "Database unavailable");
        }

        status.className = "status ready";
        status.lastElementChild.textContent = "Database connected";
      } catch (error) {
        status.className = "status error";
        status.lastElementChild.textContent = error.message || "Unable to check database";
      }
    }

    loadStatus();
  </script>
</body>
</html>`);
});

app.get("/health", async (_request, reply) => {
  try {
    await pool.query("SELECT 1");
    return { ok: true, database: "connected" };
  } catch (error) {
    app.log.error({ error }, "Health check failed");
    return reply.code(503).send({
      ok: false,
      database: "disconnected"
    });
  }
});

app.get(
  "/api/status",
  { preHandler: requireShopifySession },
  async (request) => {
    await pool.query("SELECT 1");
    return {
      ok: true,
      database: "connected",
      shop: request.shopifySession.shop
    };
  }
);

const port = Number(process.env.PORT || 3000);

await app.listen({
  port,
  host: "0.0.0.0"
});
