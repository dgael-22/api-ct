/**
 * src/scripts/shopifyMenu.ts
 * ==========================
 * Arma el menú de navegación de la tienda con las colecciones nuevas.
 *
 *   npm run shopify:menu                 (simulación)
 *   npm run shopify:menu -- --aplicar
 *
 * Crear una colección NO la pone en el menú: son dos cosas distintas en
 * Shopify. La colección es el conjunto de productos; el menú es la lista de
 * enlaces del encabezado, y se arma aparte.
 *
 * No borra nada: lee el menú principal, conserva lo que ya tiene —Tarjetas de
 * regalo, Contacto, lo que sea— y agrega los grupos que falten. Si un grupo ya
 * existe por título, lo deja como está.
 *
 * Necesita read_online_store_navigation y write_online_store_navigation.
 */
import { env } from "../config/env";

const MENU = process.env.SHOPIFY_MENU_HANDLE || "main-menu";

/** Estructura propuesta: título del grupo -> colecciones, en orden. */
const GRUPOS: { titulo: string; hijos: (string | { titulo: string; hijos: string[] })[] }[] = [
  { titulo: "Dama", hijos: [
    "Dama · Botas y Botines", "Dama · Tenis", "Dama · Tacón", "Dama · Casual",
    "Dama · De Vestir", "Dama · Confort", "Dama · Mocasines",
    "Dama · Flats y Balerinas", "Dama · Sandalias", "Dama · Zapatos"] },
  { titulo: "Caballero", hijos: [
    "Caballero · Casual", "Caballero · Zapatos", "Caballero · De Vestir",
    "Caballero · Botas y Botines", "Caballero · Tenis", "Caballero · Mocasines",
    "Caballero · Confort"] },
  { titulo: "Niños", hijos: [
    { titulo: "Niña", hijos: [
      "Niña · Casual", "Niña · Flats y Balerinas", "Niña · Sandalias", "Niña · Tenis",
      "Niña · Botas y Botines", "Niña · Zapatos", "Niña · De Vestir", "Niña · Tacón"] },
    { titulo: "Niño", hijos: [
      "Niño · Casual", "Niño · Tenis", "Niño · Zapatos", "Niño · Botas y Botines",
      "Niño · Sandalias", "Niño · De Vestir", "Niño · Mocasines"] },
    "Primeros Pasos", "Infantil", "Escolar"] },
  { titulo: "Accesorios", hijos: [
    "Cinturones", "Carteras y Monederos", "Bolsas y Mochilas", "Billeteras y Tarjeteros",
    "Calcetines", "Gorras", "Plantillas", "Agujetas", "Cuidado del Calzado"] },
  { titulo: "Ropa", hijos: [
    "Ropa Infantil", "Ropa · Playeras y Blusas", "Ropa · Shorts y Pantalones",
    "Ropa · Chamarras", "Ropa · Vestidos", "Ropa · Conjuntos"] },
  { titulo: "Hogar y Tecnología", hijos: [
    { titulo: "Electrónica", hijos: [
      "Electrónica · Pantallas y TV", "Electrónica · Celulares", "Electrónica · Audio",
      "Electrónica · Cómputo", "Electrónica · Relojes y Wearables"] },
    { titulo: "Electrodomésticos", hijos: [
      "Electrodomésticos · Refrigeración", "Electrodomésticos · Lavado",
      "Electrodomésticos · Estufas y Microondas"] },
    "Hogar y Otros"] },
  { titulo: "Novedades", hijos: ["Novedades PV26"] },
  { titulo: "Outlet", hijos: ["Outlet"] },
  { titulo: "Marcas", hijos: ["Flexi", "Flexi Country", "Quirelli", "Coqueta", "Audaz", "Procliff"] },
  { titulo: "Especialidad", hijos: ["Deportivo", "Outdoor", "Seguridad Industrial"] },
  { titulo: "Hot Sale", hijos: ["Hot Sale"] },
];

interface Coleccion { id: string; title: string; handle: string; }
interface ItemMenu { title: string; type: string; resourceId?: string; url?: string; items?: ItemMenu[]; }

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
    { method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tk },
      body: JSON.stringify({ query, variables }) });
  const texto = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 300)}`);
  const d = JSON.parse(texto) as { data?: T; errors?: { message: string }[] };
  if (d.errors?.length) throw new Error(d.errors.map((e) => e.message).join(" | "));
  if (!d.data) throw new Error("Shopify no devolvió datos.");
  return d.data;
}

const COLECCIONES = `
query cols($cursor: String) {
  collections(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node { id title handle } }
  }
}`;

const MENUS = `
query menus {
  menus(first: 25) {
    edges { node { id handle title
      items { title type url resourceId
        items { title type url resourceId
          items { title type url resourceId } } } } }
  }
}`;

const ACTUALIZAR = `
mutation actualizar($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
    menu { id handle }
    userErrors { field message }
  }
}`;

async function principal(): Promise<void> {
  const aplicar = process.argv.includes("--aplicar");
  const tk = await token();

  // --- colecciones por título
  const porTitulo = new Map<string, Coleccion>();
  let cursor: string | null = null;
  do {
    const d: { collections: { pageInfo: { hasNextPage: boolean; endCursor: string };
                              edges: { node: Coleccion }[] } } = await gql(tk, COLECCIONES, { cursor });
    for (const e of d.collections.edges) porTitulo.set(e.node.title, e.node);
    cursor = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
  } while (cursor);
  console.log(`Colecciones en la tienda: ${porTitulo.size}`);

  // --- menú
  const dm = await gql<{ menus: { edges: { node: { id: string; handle: string; title: string; items: ItemMenu[] } }[] } }>(tk, MENUS);
  const menu = dm.menus.edges.map((e) => e.node).find((m) => m.handle === MENU);
  if (!menu) {
    console.error(`No encontré el menú con handle "${MENU}". Los que hay: ` +
      dm.menus.edges.map((e) => e.node.handle).join(", "));
    process.exit(1);
  }
  console.log(`Menú: ${menu.title} (${menu.handle}) — ${menu.items.length} elementos actuales\n`);

  const yaEstan = new Set(menu.items.map((i) => i.title));
  const faltantes: string[] = [];

  function aItem(nombre: string): ItemMenu | null {
    const col = porTitulo.get(nombre);
    if (!col) { faltantes.push(nombre); return null; }
    return { title: nombre.includes(" · ") ? nombre.split(" · ")[1] : nombre,
             type: "COLLECTION", resourceId: col.id };
  }

  const nuevos: ItemMenu[] = [];
  for (const grupo of GRUPOS) {
    if (yaEstan.has(grupo.titulo)) {
      console.log(`  = ya existe   ${grupo.titulo}`);
      continue;
    }
    const hijos: ItemMenu[] = [];
    for (const h of grupo.hijos) {
      if (typeof h === "string") {
        const it = aItem(h); if (it) hijos.push(it);
      } else {
        const nietos = h.hijos.map(aItem).filter((x): x is ItemMenu => x !== null);
        if (nietos.length) hijos.push({ title: h.titulo, type: "HTTP", url: "#", items: nietos });
      }
    }
    if (!hijos.length) continue;
    // El grupo apunta a su primera colección; los hijos cuelgan de él.
    nuevos.push({ title: grupo.titulo, type: hijos[0].type, resourceId: hijos[0].resourceId,
                  url: hijos[0].url, items: hijos });
    console.log(`  + agregar     ${grupo.titulo}  (${hijos.length} subelementos)`);
  }

  if (faltantes.length) {
    console.warn(`\nNo encontré estas colecciones, se omiten:\n   ${faltantes.join("\n   ")}`);
  }
  if (!nuevos.length) { console.log("\nNo hay nada que agregar."); return; }

  if (!aplicar) {
    console.log(`\nSimulación. Para aplicarlo:\n  npm run shopify:menu -- --aplicar`);
    return;
  }

  const items = [...menu.items, ...nuevos];
  const d = await gql<{ menuUpdate: { userErrors: { field: string[] | null; message: string }[] } }>(
    tk, ACTUALIZAR, { id: menu.id, title: menu.title, handle: menu.handle, items });
  if (d.menuUpdate.userErrors.length) {
    console.error("Shopify rechazó el menú:");
    for (const e of d.menuUpdate.userErrors) console.error(`   ${(e.field ?? []).join(".")}: ${e.message}`);
    process.exit(1);
  }
  console.log(`\nMenú actualizado: ${menu.items.length} elementos previos + ${nuevos.length} nuevos.`);
}

principal()
  .then(() => process.exit(0))
  .catch((e) => {
    const m = (e as Error).message;
    console.error("\nFalló:", m);
    if (/access denied|not authorized/i.test(m)) {
      console.error(
        "\nFaltan los alcances de navegación. Agrégalos en el Dev Dashboard:\n" +
        "  read_online_store_navigation,write_online_store_navigation"
      );
    }
    process.exit(1);
  });
