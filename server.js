import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";

const { Pool } = pg;
const SHOPIFY_API_VERSION = "2026-07";
const SHOPIFY_PAGE_SIZE = 100;

let accessTokenCache = null;

const app = Fastify({ logger: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 10000
});

pool.on("error", (error) => {
  app.log.error({ error }, "Unexpected idle PostgreSQL connection error");
});

function configuredShopDomain() {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN?.trim().toLowerCase();

  if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new Error("SHOPIFY_SHOP_DOMAIN is not configured correctly");
  }

  return shop;
}

async function getShopifyAccessToken() {
  const now = Date.now();

  if (accessTokenCache && accessTokenCache.expiresAt > now + 300000) {
    return accessTokenCache.token;
  }

  const response = await fetch(
    `https://${configuredShopDomain()}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.SHOPIFY_API_KEY || "",
        client_secret: process.env.SHOPIFY_API_SECRET || ""
      }),
      signal: AbortSignal.timeout(15000)
    }
  );
  const body = await response.json().catch(() => ({}));

  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error(
      body.error_description || body.error || "Unable to authenticate with Shopify"
    );
  }

  accessTokenCache = {
    token: body.access_token,
    expiresAt: now + Number(body.expires_in || 86399) * 1000
  };

  return accessTokenCache.token;
}

async function shopifyGraphql(query, variables = {}, mayRefreshToken = true) {
  const response = await fetch(
    `https://${configuredShopDomain()}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": await getShopifyAccessToken()
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000)
    }
  );

  if (response.status === 401 && mayRefreshToken) {
    accessTokenCache = null;
    return shopifyGraphql(query, variables, false);
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Shopify request failed with status ${response.status}`);
  }

  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("; "));
  }

  return body.data;
}

function numericShopifyId(gid) {
  return String(gid || "").match(/\/(\d+)$/)?.[1] || null;
}

function normalizedAddress(address) {
  return [
    address?.address1,
    address?.address2,
    address?.city,
    address?.provinceCode,
    address?.zip,
    address?.countryCodeV2
  ]
    .map((value) => String(value || "").trim().toUpperCase())
    .join("|");
}

function displayAddress(address) {
  return [
    address?.address1,
    address?.address2,
    address?.city,
    address?.province,
    address?.zip
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(", ");
}

async function fetchInProgressOrders() {
  const orders = new Map();
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphql(
      `query LabelDispatchOrders($first: Int!, $after: String) {
        fulfillmentOrders(
          first: $first,
          after: $after,
          query: "status:in_progress"
        ) {
          nodes {
            id
            status
            updatedAt
            order {
              id
              legacyResourceId
              name
              customer {
                id
                legacyResourceId
                displayName
              }
              shippingAddress {
                name
                company
                address1
                address2
                city
                province
                provinceCode
                zip
                countryCodeV2
              }
              route: metafield(namespace: "kvb", key: "fulfilment_route") {
                value
              }
              van: metafield(namespace: "kvb", key: "van_number") {
                value
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { first: SHOPIFY_PAGE_SIZE, after }
    );
    const connection = data.fulfillmentOrders;

    for (const fulfillmentOrder of connection.nodes) {
      const order = fulfillmentOrder.order;

      if (fulfillmentOrder.status !== "IN_PROGRESS" || !order) continue;

      const existing = orders.get(order.id);
      if (existing) {
        existing.fulfillment_order_ids.push(fulfillmentOrder.id);
        continue;
      }

      const customerId = order.customer
        ? String(order.customer.legacyResourceId || numericShopifyId(order.customer.id))
        : null;
      const numericOrderId = String(
        order.legacyResourceId || numericShopifyId(order.id)
      );

      orders.set(order.id, {
        order_id: order.id,
        order_numeric_id: numericOrderId,
        order_name: order.name,
        order_url: `https://${configuredShopDomain()}/admin/orders/${numericOrderId}`,
        customer_id: customerId,
        customer_name: order.customer?.displayName || order.shippingAddress?.name || "Guest",
        customer_url: customerId
          ? `https://${configuredShopDomain()}/admin/customers/${customerId}`
          : null,
        shipping_name: order.shippingAddress?.name || "",
        shipping_address: displayAddress(order.shippingAddress),
        address_key: normalizedAddress(order.shippingAddress),
        postcode: String(order.shippingAddress?.zip || "").trim().toUpperCase(),
        route_code: String(order.route?.value || "").trim().toUpperCase() || null,
        van_number: String(order.van?.value || "").trim() || null,
        in_progress_since: fulfillmentOrder.updatedAt,
        fulfillment_order_ids: [fulfillmentOrder.id]
      });
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
  }

  return Array.from(orders.values());
}

async function fetchLatestOperations(orderIds) {
  if (!orderIds.length) return new Map();

  const result = await pool.query(
    `SELECT DISTINCT ON (member.shopify_order_id)
       member.shopify_order_id,
       operations.vehicle_name,
       operations.driver_name,
       operations.stop_number,
       operations.total_stops,
       operations.planned_arrival_at,
       operations.status AS maxoptra_status
     FROM maxoptra_export_members AS member
     JOIN maxoptra_export_queue AS queue
       ON queue.id = member.queue_id
     LEFT JOIN maxoptra_delivery_operations AS operations
       ON operations.queue_id = queue.id
     WHERE queue.shop_domain = $1
       AND member.shopify_order_id = ANY($2::text[])
     ORDER BY
       member.shopify_order_id,
       operations.shift_date DESC NULLS LAST,
       operations.last_synced_at DESC NULLS LAST,
       queue.id DESC`,
    [configuredShopDomain(), orderIds]
  );

  return new Map(result.rows.map((row) => [row.shopify_order_id, row]));
}

async function listDispatchGroups() {
  const orders = await fetchInProgressOrders();
  const operations = await fetchLatestOperations(
    orders.map((order) => order.order_id)
  );
  const groups = new Map();

  for (const order of orders) {
    const operation = operations.get(order.order_id) || {};
    const key = `${order.customer_id || "guest"}|${order.address_key}`;
    const existing = groups.get(key);
    const enriched = {
      ...order,
      van_number: operation.vehicle_name || order.van_number,
      driver_name: operation.driver_name || null,
      stop_number: operation.stop_number ?? null,
      total_stops: operation.total_stops ?? null,
      planned_arrival_at: operation.planned_arrival_at || null,
      maxoptra_status: operation.maxoptra_status || null
    };

    if (existing) {
      existing.orders.push(enriched);
      existing.in_progress_since = [existing.in_progress_since, order.in_progress_since]
        .filter(Boolean)
        .sort()[0];
      if (!existing.route_code) existing.route_code = enriched.route_code;
      if (!existing.van_number) existing.van_number = enriched.van_number;
      if (existing.stop_number == null) existing.stop_number = enriched.stop_number;
      if (!existing.planned_arrival_at) {
        existing.planned_arrival_at = enriched.planned_arrival_at;
      }
      continue;
    }

    groups.set(key, {
      group_key: key,
      customer_id: order.customer_id,
      customer_name: order.customer_name,
      customer_url: order.customer_url,
      shipping_name: order.shipping_name,
      shipping_address: order.shipping_address,
      postcode: order.postcode,
      route_code: enriched.route_code,
      van_number: enriched.van_number,
      driver_name: enriched.driver_name,
      stop_number: enriched.stop_number,
      total_stops: enriched.total_stops,
      planned_arrival_at: enriched.planned_arrival_at,
      maxoptra_status: enriched.maxoptra_status,
      in_progress_since: enriched.in_progress_since,
      orders: [enriched]
    });
  }

  return Array.from(groups.values()).sort((left, right) =>
    String(left.route_code || "").localeCompare(String(right.route_code || ""), undefined, { numeric: true }) ||
    String(left.van_number || "").localeCompare(String(right.van_number || ""), undefined, { numeric: true }) ||
    (left.stop_number ?? Number.MAX_SAFE_INTEGER) - (right.stop_number ?? Number.MAX_SAFE_INTEGER) ||
    left.customer_name.localeCompare(right.customer_name)
  );
}

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
    .subtitle { margin: 6px 0 0; color: #616161; }
    .header { display: flex; justify-content: space-between; align-items: center; gap: 18px; margin-bottom: 22px; }
    .card { overflow: hidden; border: 1px solid #d8d8d8; border-radius: 12px; background: white; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 16px; border-bottom: 1px solid #ddd; }
    input, select, button { min-height: 38px; padding: 8px 12px; border: 1px solid #8c9196; border-radius: 8px; background: white; color: #202223; font: inherit; }
    input { min-width: 250px; flex: 1; }
    button { cursor: pointer; font-weight: 650; }
    button:hover { background: #f6f6f7; }
    button:disabled { cursor: wait; opacity: .65; }
    .count { margin-left: auto; color: #616161; white-space: nowrap; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 13px 14px; border-bottom: 1px solid #e1e3e5; text-align: left; vertical-align: top; }
    th { background: #f7f7f7; white-space: nowrap; font-size: 14px; }
    tbody tr:last-child td { border-bottom: 0; }
    a { color: #005bd3; font-weight: 650; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .orders { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; background: #e4f3e8; font-weight: 700; white-space: nowrap; }
    .muted { color: #616161; }
    .message { padding: 28px 16px; text-align: center; color: #616161; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <main>
    <header class="header">
      <div>
        <h1>KVB Labels</h1>
        <p class="subtitle">In Progress orders grouped into physical dispatch labels</p>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <section class="card">
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search customers, orders, addresses or postcodes">
        <select id="route-filter"><option value="">All routes</option></select>
        <select id="van-filter"><option value="">All vehicles</option></select>
        <span id="count" class="count">Loading…</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>V orders</th>
              <th>Delivery address</th>
              <th>Route</th>
              <th>Vehicle</th>
              <th>Stop</th>
              <th>Planned arrival</th>
              <th>In Progress since</th>
            </tr>
          </thead>
          <tbody id="rows"><tr><td colspan="8" class="message">Loading In Progress orders…</td></tr></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const rowsElement = document.getElementById("rows");
    const searchElement = document.getElementById("search");
    const routeElement = document.getElementById("route-filter");
    const vanElement = document.getElementById("van-filter");
    const countElement = document.getElementById("count");
    const refreshElement = document.getElementById("refresh");
    let groups = [];

    function html(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function formatDate(value) {
      if (!value) return "—";
      return new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/London"
      }).format(new Date(value));
    }

    function fillFilter(element, values, label) {
      const selected = element.value;
      element.innerHTML = '<option value="">All ' + label + "</option>" +
        values.map((value) => '<option value="' + html(value) + '">' + html(value) + "</option>").join("");
      element.value = values.includes(selected) ? selected : "";
    }

    function filteredGroups() {
      const term = searchElement.value.trim().toLowerCase();
      return groups.filter((group) => {
        const searchable = [
          group.customer_id,
          group.customer_name,
          group.shipping_address,
          group.postcode,
          group.route_code,
          group.van_number,
          ...group.orders.map((order) => order.order_name)
        ].join(" ").toLowerCase();

        return (!term || searchable.includes(term)) &&
          (!routeElement.value || group.route_code === routeElement.value) &&
          (!vanElement.value || group.van_number === vanElement.value);
      });
    }

    function render() {
      const visible = filteredGroups();
      countElement.textContent = visible.length + " labels · " +
        visible.reduce((total, group) => total + group.orders.length, 0) + " orders";

      if (!visible.length) {
        rowsElement.innerHTML = '<tr><td colspan="8" class="message">No matching In Progress orders</td></tr>';
        return;
      }

      rowsElement.innerHTML = visible.map((group) => {
        const customer = group.customer_url
          ? '<a href="' + html(group.customer_url) + '" target="_top">' + html(group.customer_name) + "</a>"
          : html(group.customer_name);
        const orders = group.orders.map((order) =>
          '<a href="' + html(order.order_url) + '" target="_top">' + html(order.order_name) + "</a>"
        ).join("");
        const stop = group.stop_number == null
          ? "—"
          : html(group.stop_number) + (group.total_stops ? " / " + html(group.total_stops) : "");

        return '<tr>' +
          '<td>' + customer + (group.customer_id ? '<div class="muted">' + html(group.customer_id) + "</div>" : "") + "</td>" +
          '<td><div class="orders">' + orders + "</div></td>" +
          '<td>' + html(group.shipping_address || group.postcode || "—") + "</td>" +
          '<td><span class="badge">' + html(group.route_code || "—") + "</span></td>" +
          '<td>' + html(group.van_number || "—") + "</td>" +
          '<td>' + stop + "</td>" +
          '<td>' + html(formatDate(group.planned_arrival_at)) + "</td>" +
          '<td>' + html(formatDate(group.in_progress_since)) + "</td>" +
          "</tr>";
      }).join("");
    }

    async function load() {
      refreshElement.disabled = true;
      rowsElement.innerHTML = '<tr><td colspan="8" class="message">Loading In Progress orders…</td></tr>';

      try {
        const token = await shopify.idToken();
        const response = await fetch("/api/dispatch-labels", {
          headers: { Authorization: "Bearer " + token }
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load orders");

        groups = body.groups;
        fillFilter(routeElement, [...new Set(groups.map((group) => group.route_code).filter(Boolean))].sort(), "routes");
        fillFilter(vanElement, [...new Set(groups.map((group) => group.van_number).filter(Boolean))].sort(), "vehicles");
        render();
      } catch (error) {
        rowsElement.innerHTML = '<tr><td colspan="8" class="message error">' + html(error.message) + "</td></tr>";
        countElement.textContent = "Unavailable";
      } finally {
        refreshElement.disabled = false;
      }
    }

    searchElement.addEventListener("input", render);
    routeElement.addEventListener("change", render);
    vanElement.addEventListener("change", render);
    refreshElement.addEventListener("click", load);
    load();
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

app.get(
  "/api/dispatch-labels",
  { preHandler: requireShopifySession },
  async (request, reply) => {
    try {
      const groups = await listDispatchGroups();
      return {
        ok: true,
        groups,
        labelCount: groups.length,
        orderCount: groups.reduce((total, group) => total + group.orders.length, 0)
      };
    } catch (error) {
      request.log.error({ error }, "Unable to load dispatch labels");
      return reply.code(500).send({
        error: error.message || "Unable to load dispatch labels"
      });
    }
  }
);

const port = Number(process.env.PORT || 3000);

await app.listen({
  port,
  host: "0.0.0.0"
});
