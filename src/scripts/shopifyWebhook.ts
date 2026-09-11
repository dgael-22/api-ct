/**
 * src/scripts/shopifyWebhook.ts
 * =============================
 * Registra en Shopify el webhook de "orden pagada" apuntando al middleware.
 *
 *   npm run shopify:webhook -- https://tu-dominio.up.railway.app
 *
 * Si no se pasa la URL, usa APP_BASE_URL del .env.
 *
 * Primero lista lo que ya está registrado. Si el webhook ya existe con la
 * misma URL no hace nada; si existe con OTRA URL lo actualiza. Registrar dos
 * veces el mismo tema sería recibir cada orden por duplicado.
 */
import { env } from "../config/env";

const TEMA = "ORDERS_PAID";
const RUTA = "/webhooks/shopify/orders-paid";

interface Suscripcion {
  id: string;
  topic: string;
  endpoint: { callbackUrl?: string } | null;
}

async function token(): Promise<string> {
  if (env.shopify.tokenFijo) return env.shopify.tokenFijo;
  const r = await fetch(`https://${env.shopify.dominio}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.shopify.clientId,
      client_secret: env.shopify.clientSecret,
    }),
  });
  if (!r.ok) { console.error(`Shopify no emitió el token (HTTP ${r.status}).`); process.exit(1); }
  return ((await r.json()) as { access_token: string }).access_token;
}

async function gql<T>(tk: string, query: string, variables?: unknown): Promise<T> {
  const r = await fetch(
    `https://${env.shopify.dominio}/admin/api/${env.shopify.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tk },
      body: JSON.stringify({ query, variables }),
    }
  );
  const texto = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 300)}`);
  const datos = JSON.parse(texto) as { data?: T; errors?: { message: string }[] };
  if (datos.errors?.length) throw new Error(datos.errors.map((e) => e.message).join(" | "));
  if (!datos.data) throw new Error("Shopify no devolvió datos.");
  return datos.data;
}

const LISTAR = `
query { webhookSubscriptions(first: 50) {
  edges { node { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } }
} }`;

const CREAR = `
mutation crear($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

const ACTUALIZAR = `
mutation actualizar($id: ID!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

function errores(bloque: { userErrors: { field: string[] | null; message: string }[] }): void {
  if (bloque.userErrors.length) {
    for (const e of bloque.userErrors) {
      console.error(`   ${(e.field ?? []).join(".")}: ${e.message}`);
    }
    process.exit(1);
  }
}

async function principal(): Promise<void> {
  const base = (process.argv[2] || env.app.baseUrl || "").replace(/\/+$/, "");
  if (!base) {
    console.error(
      "Falta la URL pública.\n" +
      "  npm run shopify:webhook -- https://tu-dominio.up.railway.app\n" +
      "o pon APP_BASE_URL en el .env."
    );
    process.exit(1);
  }
  if (!base.startsWith("https://")) {
    console.error("Shopify sólo acepta webhooks por HTTPS. La URL debe empezar con https://");
    process.exit(1);
  }

  const destino = base + RUTA;
  const tk = await token();

  console.log(`Tienda:  ${env.shopify.dominio}`);
  console.log(`Destino: ${destino}\n`);

  const { webhookSubscriptions } = await gql<{
    webhookSubscriptions: { edges: { node: Suscripcion }[] };
  }>(tk, LISTAR);
  const actuales = webhookSubscriptions.edges.map((e) => e.node);

  if (actuales.length) {
    console.log("Webhooks ya registrados por esta app:");
    for (const s of actuales) {
      console.log(`   ${s.topic.padEnd(22)} ${s.endpoint?.callbackUrl ?? "(no HTTP)"}`);
    }
    console.log("");
  } else {
    console.log("Esta app no tenía ningún webhook registrado.\n");
  }

  const mismoTema = actuales.find((s) => s.topic === TEMA);

  if (mismoTema && mismoTema.endpoint?.callbackUrl === destino) {
    console.log("Ya estaba registrado con esta misma URL. No se tocó nada.");
  } else if (mismoTema) {
    const datos = await gql<{ webhookSubscriptionUpdate: { userErrors: { field: string[] | null; message: string }[] } }>(
      tk, ACTUALIZAR, { id: mismoTema.id, sub: { callbackUrl: destino, format: "JSON" } }
    );
    errores(datos.webhookSubscriptionUpdate);
    console.log(`Actualizado: ${TEMA} ahora apunta a ${destino}`);
  } else {
    const datos = await gql<{ webhookSubscriptionCreate: { userErrors: { field: string[] | null; message: string }[] } }>(
      tk, CREAR, { topic: TEMA, sub: { callbackUrl: destino, format: "JSON" } }
    );
    errores(datos.webhookSubscriptionCreate);
    console.log(`Registrado: ${TEMA} -> ${destino}`);
  }

  console.log(
    "\nEl secreto para verificar la firma de estos webhooks es el CLIENT SECRET\n" +
    "de la app. En Railway pon:\n\n" +
    "  SHOPIFY_WEBHOOK_SECRET = el mismo valor de SHOPIFY_CLIENT_SECRET\n"
  );
}

principal()
  .then(() => process.exit(0))
  .catch((e) => { console.error("\nFalló:", (e as Error).message); process.exit(1); });
