/**
 * src/scripts/shopifyColecciones.ts
 * =================================
 * Crea (o actualiza) en Shopify las colecciones automáticas del catálogo,
 * leyendo el CSV que trae el título, el handle y los tags de cada regla.
 *
 *   npm run shopify:colecciones -- data/colecciones-shopify.csv
 *   npm run shopify:colecciones -- data/colecciones-shopify.csv --aplicar
 *
 * Sin `--aplicar` no escribe nada: sólo dice qué crearía y qué actualizaría.
 * Es a propósito — son 67 colecciones sobre una tienda real, y conviene ver
 * la lista antes de tocarla.
 *
 * Es idempotente: se busca por handle. Si la colección ya existe, se le
 * corrige la regla; si no, se crea. Correrlo dos veces no duplica nada.
 *
 * Necesita el permiso write_products en la app.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "csv-parse/sync";
import { env } from "../config/env";

interface Fila {
  titulo: string;
  handle: string;
  coinciden: string;
  tags: string[];
  esperados: number;
}

interface ColeccionRemota {
  id: string;
  handle: string;
  title: string;
}

const LISTAR = `
query colecciones($cursor: String) {
  collections(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node { id handle title } }
  }
}`;

const CREAR = `
mutation crear($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection { id handle }
    userErrors { field message }
  }
}`;

const ACTUALIZAR = `
mutation actualizar($input: CollectionInput!) {
  collectionUpdate(input: $input) {
    collection { id handle }
    userErrors { field message }
  }
}`;

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

function leerCsv(ruta: string): Fila[] {
  const filas = parse(fs.readFileSync(ruta, "utf8"), {
    columns: true, skip_empty_lines: true, bom: true,
  }) as Record<string, string>[];

  return filas.map((f) => {
    const tags = ["Tag 1", "Tag 2", "Tag 3"]
      .map((c) => (f[c] ?? "").trim())
      .filter(Boolean);
    return {
      titulo: (f["Título de la colección"] ?? "").trim(),
      handle: (f["Handle"] ?? "").trim(),
      coinciden: (f["Coinciden"] ?? "todas").trim().toLowerCase(),
      tags,
      esperados: Number(f["Productos"] ?? 0),
    };
  }).filter((f) => f.titulo && f.handle && f.tags.length);
}

function entrada(fila: Fila, id?: string) {
  return {
    ...(id ? { id } : {}),
    title: fila.titulo,
    handle: fila.handle,
    ruleSet: {
      // "alguna" -> se cumple con una regla; "todas" -> hay que cumplirlas todas.
      appliedDisjunctively: fila.coinciden === "alguna",
      rules: fila.tags.map((t) => ({ column: "TAG", relation: "EQUALS", condition: t })),
    },
  };
}

async function principal(): Promise<void> {
  const ruta = process.argv[2] ?? "data/colecciones-shopify.csv";
  const aplicar = process.argv.includes("--aplicar");
  const absoluta = path.resolve(ruta);

  if (!fs.existsSync(absoluta)) {
    console.error(`No encuentro ${absoluta}\n  npm run shopify:colecciones -- data/colecciones-shopify.csv`);
    process.exit(1);
  }

  const filas = leerCsv(absoluta);
  console.log(`Tienda:     ${env.shopify.dominio}`);
  console.log(`Archivo:    ${absoluta}`);
  console.log(`Colecciones en el archivo: ${filas.length}`);
  console.log(aplicar ? "Modo:       APLICAR (se va a escribir en la tienda)\n"
                      : "Modo:       simulación — no se escribe nada. Agrega --aplicar para hacerlo.\n");

  const tk = await token();

  // --- lo que ya existe, por handle
  const existentes = new Map<string, ColeccionRemota>();
  let cursor: string | null = null;
  do {
    const d: { collections: { pageInfo: { hasNextPage: boolean; endCursor: string };
                              edges: { node: ColeccionRemota }[] } } =
      await gql(tk, LISTAR, { cursor });
    for (const e of d.collections.edges) existentes.set(e.node.handle, e.node);
    cursor = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
  } while (cursor);
  console.log(`La tienda ya tiene ${existentes.size} colecciones.\n`);

  let creadas = 0, actualizadas = 0, fallidas = 0;

  for (const fila of filas) {
    const ya = existentes.get(fila.handle);
    const accion = ya ? "actualizar" : "crear";
    const regla = fila.tags.join(fila.coinciden === "alguna" ? "  o  " : "  +  ");

    if (!aplicar) {
      console.log(`  [${accion.padEnd(10)}] ${fila.titulo.padEnd(34)} ${regla}`);
      continue;
    }

    try {
      if (ya) {
        const d = await gql<{ collectionUpdate: { userErrors: { field: string[] | null; message: string }[] } }>(
          tk, ACTUALIZAR, { input: entrada(fila, ya.id) });
        if (d.collectionUpdate.userErrors.length) throw new Error(
          d.collectionUpdate.userErrors.map((e) => e.message).join(" | "));
        actualizadas++;
      } else {
        const d = await gql<{ collectionCreate: { userErrors: { field: string[] | null; message: string }[] } }>(
          tk, CREAR, { input: entrada(fila) });
        if (d.collectionCreate.userErrors.length) throw new Error(
          d.collectionCreate.userErrors.map((e) => e.message).join(" | "));
        creadas++;
      }
      console.log(`  ✓ ${accion.padEnd(10)} ${fila.titulo}`);
    } catch (e) {
      fallidas++;
      console.error(`  ✗ ${accion.padEnd(10)} ${fila.titulo}  ->  ${(e as Error).message}`);
    }

    // Shopify limita la frecuencia de escritura; una pausa corta lo evita.
    await new Promise((r) => setTimeout(r, 350));
  }

  if (aplicar) {
    console.log(`\nCreadas: ${creadas} · Actualizadas: ${actualizadas} · Fallidas: ${fallidas}`);
    console.log(
      "\nShopify tarda un momento en calcular cuántos productos entran en cada\n" +
      "colección. Si al abrirlas se ven vacías, espera y recarga."
    );
  } else {
    console.log(`\nNada se escribió. Para hacerlo:\n  npm run shopify:colecciones -- ${ruta} --aplicar`);
  }
}

principal()
  .then(() => process.exit(0))
  .catch((e) => {
    const m = (e as Error).message;
    console.error("\nFalló:", m);
    if (/access denied|not authorized/i.test(m)) {
      console.error(
        "\nEs el permiso write_products. Agrégalo en el Dev Dashboard:\n" +
        "  read_products,write_products,read_inventory,write_inventory,\n" +
        "  read_locations,read_orders,write_orders\n" +
        "publica una versión nueva y reinstala la app en la tienda."
      );
    }
    process.exit(1);
  });
