/**
 * src/scripts/shopifyOrganizar.ts
 * ===============================
 * Deja cada producto de la tienda como dice data/organizacion.csv: tags del
 * vocabulario cerrado, Vendor y Type con una sola grafía, metafields de los
 * filtros, y las opciones de variante con un solo nombre (Talla, Color).
 *
 *   npm run shopify:organizar                                  (simulación)
 *   npm run shopify:organizar -- --aplicar --limite 5          (prueba chica)
 *   npm run shopify:organizar -- --aplicar
 *   npm run shopify:organizar -- --handle 1390014236           (un producto)
 *
 * El CSV lo escribe schu-catalogo (python retaguear.py). Se escribe por la API
 * campo por campo, NUNCA con un CSV de importación parcial: ése le hace creer
 * a Shopify que el producto perdió sus variantes.
 *
 * Idempotente: un producto que ya está como debe no se toca. Sólo cambia el
 * NOMBRE de las opciones y la grafía de colores y materiales; las tallas, los
 * SKU y el inventario no se tocan. Si al normalizar dos colores del mismo
 * producto quedarían iguales ("NEGRO" y "Negro"), se detiene ese cambio y se
 * reporta: no se adivina cuál variante es cuál.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "csv-parse/sync";
import {
  alFallar, gql, pausa, revisar, todosLosProductos, token,
  type ErrorUsuario, type ProductoRemoto,
} from "./_shopify";

type Fila = Record<string, string>;

const ACTUALIZAR = `
mutation actualizar($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id } userErrors { field message } }
}`;

const BORRAR_METAFIELDS = `
mutation borrar($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } }
}`;

const OPCION = `
mutation opcion($productId: ID!, $option: OptionUpdateInput!, $optionValuesToUpdate: [OptionValueUpdateInput!]) {
  productOptionUpdate(productId: $productId, option: $option,
                      optionValuesToUpdate: $optionValuesToUpdate, variantStrategy: LEAVE_AS_IS) {
    product { id }
    userErrors { field message code }
  }
}`;

// --- opciones de variante ---------------------------------------------------
const sinAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

const NOMBRES_OPCION: Record<string, string> = {
  talla: "Talla", size: "Talla", "talla del calzado": "Talla",
  color: "Color", material: "Material", "tamano": "Tamaño",
};
export function nombreOpcion(nombre: string): string {
  return NOMBRES_OPCION[sinAcentos(nombre.trim().toLowerCase())] ?? nombre.trim();
}

const PALABRAS: Record<string, string> = {
  cafe: "Café", marron: "Marrón", salmon: "Salmón", limon: "Limón", camel: "Camel",
  y: "y", de: "de", con: "con",
};
/** "CAFE CLARO" -> "Café Claro", "BLANCO-FIUSHA" -> "Blanco-Fiusha". */
export function valorLegible(valor: string): string {
  return valor.trim().replace(/\s+/g, " ").toLowerCase()
    .split(/(\s|-|\/)/)
    .map((p, i) => {
      if (/^(\s|-|\/)$/.test(p) || !p) return p;
      const fijo = PALABRAS[sinAcentos(p)];
      if (fijo && (i > 0 || fijo[0] === fijo[0].toUpperCase())) return fijo;
      return p[0].toUpperCase() + p.slice(1);
    }).join("");
}

interface CambioOpcion { id: string; de: string; a: string; valores: { id: string; de: string; a: string }[] }

function cambiosDeOpciones(p: ProductoRemoto, avisos: string[]): CambioOpcion[] {
  const cambios: CambioOpcion[] = [];
  for (const o of p.options) {
    const nombre = nombreOpcion(o.name);
    let valores: CambioOpcion["valores"] = [];
    if (nombre === "Color" || nombre === "Material") {
      valores = o.optionValues
        .map((v) => ({ id: v.id, de: v.name, a: valorLegible(v.name) }))
        .filter((v) => v.de !== v.a);
      const finales = o.optionValues.map((v) => valorLegible(v.name));
      if (new Set(finales).size !== finales.length) {
        avisos.push(`${p.handle}: dos valores de ${nombre} quedarían iguales (${o.optionValues.map((v) => v.name).join(", ")}); no se normalizan`);
        valores = [];
      }
    }
    if (nombre !== o.name || valores.length) cambios.push({ id: o.id, de: o.name, a: nombre, valores });
  }
  return cambios;
}

// --- metafields -------------------------------------------------------------
function listaActual(p: ProductoRemoto, key: string): string[] {
  const n = p.metafields.nodes.find((m) => m.key === key);
  try { return n ? (JSON.parse(n.value) as string[]) : []; } catch { return []; }
}

const mismaLista = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const mismoConjunto = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// --- principal --------------------------------------------------------------
async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const valor = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const aplicar = args.includes("--aplicar");
  const limite = Number(valor("--limite") ?? Infinity);
  const soloHandle = valor("--handle");
  const ruta = path.resolve(args.find((a) => a.endsWith(".csv")) ?? "data/organizacion.csv");
  const voc = JSON.parse(fs.readFileSync(path.resolve("data/vocabulario.json"), "utf8")) as
    { metafields: Record<string, { valores: string[] }> };
  const claves = Object.keys(voc.metafields);

  const filas = parse(fs.readFileSync(ruta, "utf8"), { columns: true, skip_empty_lines: true, bom: true }) as Fila[];
  const porHandle = new Map(filas.map((f) => [f.Handle, f]));
  console.log(`Archivo: ${ruta} (${filas.length} productos)`);
  console.log(aplicar ? `Modo: APLICAR${Number.isFinite(limite) ? `, límite ${limite}` : ""}\n`
                      : "Modo: simulación — agrega --aplicar para escribir.\n");

  const tk = await token();
  const productos = await todosLosProductos(tk);
  console.log(`Productos en la tienda: ${productos.length}`);

  let sinCambio = 0, conCambio = 0, hechos = 0, fallidos = 0, ejemplos = 0;
  const avisos: string[] = [];
  const vistos = new Set<string>();

  for (const p of productos) {
    if (soloHandle && p.handle !== soloHandle) continue;
    const f = porHandle.get(p.handle);
    if (!f) continue;
    vistos.add(p.handle);

    const entrada: Record<string, unknown> = { id: p.id };
    const detalle: string[] = [];

    const tags = f.Tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (!mismoConjunto(tags, p.tags)) {
      entrada.tags = tags;
      const quita = p.tags.filter((t) => !tags.includes(t)), pone = tags.filter((t) => !p.tags.includes(t));
      detalle.push(`tags  -[${quita.join(", ")}]  +[${pone.join(", ")}]`);
    }
    if (f.Vendor && f.Vendor !== p.vendor) { entrada.vendor = f.Vendor; detalle.push(`vendor ${p.vendor} -> ${f.Vendor}`); }
    if (f.Type && f.Type !== p.productType) { entrada.productType = f.Type; detalle.push(`type ${p.productType} -> ${f.Type}`); }

    const metafields = [];
    const aBorrar: { ownerId: string; namespace: string; key: string }[] = [];
    for (const k of claves) {
      const nuevos = (f[k] ?? "").split(" | ").map((x) => x.trim()).filter(Boolean);
      // Un filtro que el producto ya no debe tener se borra: si no, un "Tacón"
      // mal puesto seguiría apareciendo en el filtro aunque se quite el tag.
      if (!nuevos.length && listaActual(p, k).length) {
        aBorrar.push({ ownerId: p.id, namespace: "custom", key: k });
        detalle.push(`${k}=(se borra: ${listaActual(p, k).join("/")})`);
        continue;
      }
      if (!nuevos.length || mismaLista(nuevos, listaActual(p, k))) continue;
      const fuera = nuevos.filter((x) => !voc.metafields[k].valores.includes(x));
      if (fuera.length) { avisos.push(`${p.handle}: ${k} trae valores fuera de la lista (${fuera.join(", ")})`); continue; }
      metafields.push({ namespace: "custom", key: k, type: "list.single_line_text_field", value: JSON.stringify(nuevos) });
      detalle.push(`${k}=${nuevos.join("/")}`);
    }
    if (metafields.length) entrada.metafields = metafields;

    const opciones = cambiosDeOpciones(p, avisos);
    for (const o of opciones) {
      detalle.push(`opción ${o.de}${o.a !== o.de ? ` -> ${o.a}` : ""}` +
        (o.valores.length ? ` [${o.valores.map((v) => `${v.de}->${v.a}`).join(", ")}]` : ""));
    }

    if (!detalle.length) { sinCambio++; continue; }
    conCambio++;
    if (!aplicar || soloHandle) {
      if (ejemplos++ < 25 || soloHandle) console.log(`  ${p.handle.padEnd(28)} ${detalle.join(" · ")}`);
      if (!aplicar) continue;
    }
    if (hechos >= limite) continue;

    try {
      if (Object.keys(entrada).length > 1) {
        const r = await gql<{ productUpdate: { userErrors: ErrorUsuario[] } }>(tk, ACTUALIZAR, { product: entrada });
        revisar(r.productUpdate.userErrors);
      }
      if (aBorrar.length) {
        const r = await gql<{ metafieldsDelete: { userErrors: ErrorUsuario[] } }>(tk, BORRAR_METAFIELDS, { metafields: aBorrar });
        revisar(r.metafieldsDelete.userErrors);
      }
      for (const o of opciones) {
        const r = await gql<{ productOptionUpdate: { userErrors: ErrorUsuario[] } }>(tk, OPCION, {
          productId: p.id,
          option: { id: o.id, name: o.a },
          optionValuesToUpdate: o.valores.length ? o.valores.map((v) => ({ id: v.id, name: v.a })) : null,
        });
        revisar(r.productOptionUpdate.userErrors);
      }
      hechos++;
      if (hechos % 50 === 0 || Number.isFinite(limite)) console.log(`  ✓ ${hechos}  ${p.handle}`);
    } catch (e) {
      fallidos++;
      console.error(`  ✗ ${p.handle} -> ${(e as Error).message}`);
    }
    await pausa(120);
  }

  const noEstan = filas.filter((f) => !vistos.has(f.Handle)).map((f) => f.Handle);
  const fuera = productos.filter((p) => !porHandle.has(p.handle) && p.status === "ACTIVE").length;

  console.log(`\nYa estaban bien: ${sinCambio} · Con cambios: ${conCambio}` +
              (aplicar ? ` · Aplicados: ${hechos} · Fallidos: ${fallidos}` : ""));
  if (!soloHandle) {
    console.log(`Handles del CSV que no están en la tienda: ${noEstan.length}${noEstan.length ? ` (${noEstan.slice(0, 5).join(", ")})` : ""}`);
    console.log(`Productos activos de la tienda que no vienen en el CSV (no se tocan): ${fuera}`);
  }
  if (avisos.length) {
    console.log(`\nDetenidos para revisión (${avisos.length}):`);
    for (const a of avisos.slice(0, 40)) console.log(`  ${a}`);
  }
  if (fallidos) process.exitCode = 1;
}

if (require.main === module) {
  principal().then(() => process.exit(process.exitCode ?? 0)).catch(alFallar);
}
