/**
 * src/scripts/_shopify.ts
 * =======================
 * Lo que comparten los scripts de catálogo: el token y las llamadas GraphQL.
 *
 * Shopify limita las escrituras por un "cubo" de costo. Cuando se vacía
 * responde THROTTLED; aquí se espera y se reintenta, en vez de tronar a la
 * mitad de 1,800 productos. Sólo se reintenta ese caso: un error de datos se
 * devuelve tal cual.
 */
import { env } from "../config/env";

export async function token(): Promise<string> {
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

export const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function gql<T>(tk: string, query: string, variables?: unknown): Promise<T> {
  for (let intento = 1; ; intento++) {
    const r = await fetch(
      `https://${env.shopify.dominio}/admin/api/${env.shopify.apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tk },
        body: JSON.stringify({ query, variables }),
      }
    );
    const texto = await r.text();
    const limitado = r.status === 429 || /THROTTLED/.test(texto);
    if (limitado && intento < 6) { await pausa(2000 * intento); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 300)}`);
    const datos = JSON.parse(texto) as { data?: T; errors?: { message: string }[] };
    if (datos.errors?.length) throw new Error(datos.errors.map((e) => e.message).join(" | "));
    if (!datos.data) throw new Error("Shopify no devolvió datos.");
    return datos.data;
  }
}

export interface ErrorUsuario { field: string[] | null; message: string }

export function revisar(errores: ErrorUsuario[] | undefined): void {
  if (errores?.length) throw new Error(errores.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join(" | "));
}

export interface ProductoRemoto {
  id: string;
  handle: string;
  title: string;
  vendor: string;
  productType: string;
  status: string;
  createdAt: string;
  tags: string[];
  variants: { nodes: { sku: string | null }[] };
  options: { id: string; name: string; optionValues: { id: string; name: string }[] }[];
  metafields: { nodes: { key: string; value: string }[] };
}

const PRODUCTOS = `
query productos($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id handle title vendor productType status createdAt tags
      variants(first: 5) { nodes { sku } }
      options { id name optionValues { id name } }
      metafields(first: 20, namespace: "custom") { nodes { key value } } }
  }
}`;

export async function todosLosProductos(tk: string): Promise<ProductoRemoto[]> {
  const salida: ProductoRemoto[] = [];
  let cursor: string | null = null;
  do {
    const d: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ProductoRemoto[] } } =
      await gql(tk, PRODUCTOS, { cursor });
    salida.push(...d.products.nodes);
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);
  return salida;
}

export function alFallar(e: unknown): never {
  const m = (e as Error).message;
  console.error("\nFalló:", m);
  if (/access denied|not authorized/i.test(m)) {
    console.error("\nEs un permiso de la app. Compruébalo con: npm run shopify:locations");
  }
  process.exit(1);
}
