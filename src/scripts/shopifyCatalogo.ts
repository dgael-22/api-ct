/**
 * src/scripts/shopifyCatalogo.ts
 * ==============================
 * Paso 4, lado Shopify. Baja TODAS las variantes de la tienda y las deja en
 * un CSV. Ese CSV es la mitad izquierda de la tabla de mapeo: lo que hay que
 * casar contra el catálogo de CT cuando CT nos autorice.
 *
 *   npm run shopify:catalogo
 *
 * Se hace por API y no con la exportación manual del admin por dos razones:
 * el `inventoryItemId` —que es lo que de verdad se necesita para escribir
 * existencias— no viene en el CSV que exporta Shopify, y así el archivo se
 * vuelve a generar en cualquier momento sin depender de nadie.
 *
 * No escribe nada en Shopify. Sólo lee.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { env } from "../config/env";

interface Variante {
  id: string;
  sku: string | null;
  barcode: string | null;
  title: string;
  inventoryItem: { id: string } | null;
  product: { title: string; status: string } | null;
}

const CONSULTA = `
query variantes($cursor: String) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        barcode
        title
        inventoryItem { id }
        product { title status }
      }
    }
  }
}`;

async function token(): Promise<string> {
  if (env.shopify.tokenFijo) return env.shopify.tokenFijo;
  const respuesta = await fetch(
    `https://${env.shopify.dominio}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.shopify.clientId,
        client_secret: env.shopify.clientSecret,
      }),
    }
  );
  if (!respuesta.ok) {
    console.error(`Shopify no emitió el token (HTTP ${respuesta.status}).`);
    process.exit(1);
  }
  return ((await respuesta.json()) as { access_token: string }).access_token;
}

async function pagina(
  tk: string,
  cursor: string | null
): Promise<{ nodos: Variante[]; siguiente: string | null }> {
  const respuesta = await fetch(
    `https://${env.shopify.dominio}/admin/api/${env.shopify.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tk },
      body: JSON.stringify({ query: CONSULTA, variables: { cursor } }),
    }
  );
  const texto = await respuesta.text();
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}: ${texto.slice(0, 300)}`);

  const datos = JSON.parse(texto) as {
    data?: { productVariants?: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      edges: { node: Variante }[];
    } };
    errors?: { message: string }[];
  };
  if (datos.errors?.length) throw new Error(datos.errors.map((e) => e.message).join(" | "));

  const bloque = datos.data?.productVariants;
  if (!bloque) throw new Error("Shopify no devolvió variantes.");
  return {
    nodos: bloque.edges.map((e) => e.node),
    siguiente: bloque.pageInfo.hasNextPage ? bloque.pageInfo.endCursor : null,
  };
}

/** Escapa un campo para CSV: comillas dobles duplicadas y todo entrecomillado. */
function celda(valor: string | null | undefined): string {
  return `"${(valor ?? "").replace(/"/g, '""')}"`;
}

async function principal(): Promise<void> {
  const tk = await token();

  const todas: Variante[] = [];
  let cursor: string | null = null;
  let vuelta = 0;

  do {
    const { nodos, siguiente } = await pagina(tk, cursor);
    todas.push(...nodos);
    cursor = siguiente;
    vuelta += 1;
    process.stdout.write(`\rDescargando… ${todas.length} variantes (página ${vuelta})`);
  } while (cursor);

  process.stdout.write("\n");

  const destino = path.resolve("data", "catalogo-shopify.csv");
  fs.mkdirSync(path.dirname(destino), { recursive: true });

  const encabezado = [
    "shopifyVariantId", "shopifySku", "barcode",
    "producto", "variante", "estadoProducto", "inventoryItemId",
  ].join(",");

  const lineas = todas.map((v) => [
    celda(v.id),
    celda(v.sku),
    celda(v.barcode),
    celda(v.product?.title),
    celda(v.title),
    celda(v.product?.status),
    celda(v.inventoryItem?.id),
  ].join(","));

  fs.writeFileSync(destino, [encabezado, ...lineas].join("\n") + "\n", "utf8");

  // ---- lo que conviene saber antes de mapear ----
  const sinSku = todas.filter((v) => !v.sku || !v.sku.trim()).length;
  const sinItem = todas.filter((v) => !v.inventoryItem).length;

  const cuenta = new Map<string, number>();
  for (const v of todas) {
    const s = (v.sku ?? "").trim();
    if (s) cuenta.set(s, (cuenta.get(s) ?? 0) + 1);
  }
  const repetidos = [...cuenta.entries()].filter(([, n]) => n > 1);

  console.log(`\nVariantes:        ${todas.length}`);
  console.log(`Sin SKU:          ${sinSku}`);
  console.log(`Sin inventoryItem:${sinItem}`);
  console.log(`SKU repetidos:    ${repetidos.length}`);
  if (repetidos.length) {
    for (const [sku, n] of repetidos.slice(0, 10)) console.log(`   ${sku} × ${n}`);
    if (repetidos.length > 10) console.log(`   … y ${repetidos.length - 10} más`);
    console.log(
      "\nUn SKU repetido no se puede mapear solo: apunta a dos variantes\n" +
      "distintas y no hay forma de saber a cuál escribirle el inventario."
    );
  }
  if (sinSku) {
    console.log(
      `\nLas ${sinSku} variantes sin SKU quedan fuera del mapeo. El SKU es la\n` +
      "llave contra CT; sin él no hay con qué cruzar."
    );
  }

  console.log(`\nArchivo: ${destino}`);
}

principal()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFalló:", (e as Error).message);
    process.exit(1);
  });
