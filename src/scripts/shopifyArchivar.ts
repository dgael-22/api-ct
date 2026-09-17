/**
 * src/scripts/shopifyArchivar.ts
 * ==============================
 * Archiva los productos de una carga que quedaron duplicados por otra.
 *
 *   npm run shopify:archivar -- --lote 2026-09-04                (simulación)
 *   npm run shopify:archivar -- --lote 2026-09-04 --aplicar
 *   npm run shopify:archivar -- --revertir data/archivados-2026-09-04.csv --aplicar
 *
 * Una importación con handles distintos crea productos nuevos en vez de
 * actualizar los existentes. Aquí se archiva un producto de `--lote` SÓLO si
 * tiene un gemelo vivo en otra carga: mismo título, o un SKU que es el handle
 * o el SKU del otro. Un producto sin gemelo no se toca: se lista y se decide
 * a mano.
 *
 * Archivar NO borra: el producto sale de la tienda y de las colecciones, y
 * con --revertir vuelve a ACTIVE. La lista queda en data/archivados-<lote>.csv.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "csv-parse/sync";
import { alFallar, gql, pausa, revisar, todosLosProductos, token, type ErrorUsuario } from "./_shopify";

const ESTADO = `
mutation estado($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id status } userErrors { field message } }
}`;

const norma = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const celda = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function cambiarEstado(tk: string, ids: string[], status: "ARCHIVED" | "ACTIVE"): Promise<number> {
  let fallidos = 0;
  for (const [i, id] of ids.entries()) {
    try {
      const r = await gql<{ productUpdate: { userErrors: ErrorUsuario[] } }>(tk, ESTADO, { product: { id, status } });
      revisar(r.productUpdate.userErrors);
      if ((i + 1) % 100 === 0) console.log(`  ✓ ${i + 1}/${ids.length}`);
    } catch (e) {
      fallidos++;
      console.error(`  ✗ ${id} -> ${(e as Error).message}`);
    }
    await pausa(120);
  }
  return fallidos;
}

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const valor = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const aplicar = args.includes("--aplicar");
  const tk = await token();

  const revertir = valor("--revertir");
  if (revertir) {
    const filas = parse(fs.readFileSync(path.resolve(revertir), "utf8"), { columns: true, bom: true }) as { id: string }[];
    console.log(`Reactivar ${filas.length} productos de ${revertir}`);
    if (!aplicar) { console.log("Simulación. Agrega --aplicar."); return; }
    const fallidos = await cambiarEstado(tk, filas.map((f) => f.id), "ACTIVE");
    console.log(`Reactivados: ${filas.length - fallidos} · Fallidos: ${fallidos}`);
    return;
  }

  const lote = valor("--lote");
  if (!lote || !/^\d{4}-\d{2}-\d{2}$/.test(lote)) {
    console.error("Falta --lote AAAA-MM-DD (fecha de creación en UTC de la carga duplicada).");
    process.exit(1);
  }

  // --proteger <csv>: los handles de ese CSV (el catálogo bueno) nunca se archivan.
  const proteger = valor("--proteger");
  const protegidos = new Set<string>(proteger
    ? (parse(fs.readFileSync(path.resolve(proteger), "utf8"), { columns: true, bom: true }) as { Handle: string }[]).map((f) => f.Handle)
    : []);

  const productos = await todosLosProductos(tk);
  const delLote = productos.filter((p) => p.createdAt.startsWith(lote) && p.status === "ACTIVE" && !protegidos.has(p.handle));
  if (protegidos.size) console.log(`Protegidos por ${proteger}: ${protegidos.size} handles`);
  const otros = productos.filter((p) => !p.createdAt.startsWith(lote) && p.status === "ACTIVE");

  const porTitulo = new Map(otros.map((p) => [norma(p.title), p]));
  const porClave = new Map<string, (typeof otros)[number]>();
  for (const p of otros) {
    porClave.set(p.handle, p);
    for (const v of p.variants.nodes) if (v.sku) porClave.set(v.sku, p);
  }

  const archivar: { id: string; handle: string; title: string; gemelo: string; motivo: string }[] = [];
  const sinGemelo: typeof delLote = [];
  for (const p of delLote) {
    const t = porTitulo.get(norma(p.title));
    const s = p.variants.nodes.map((v) => v.sku && porClave.get(v.sku)).find(Boolean);
    const gemelo = t ?? s;
    if (gemelo) archivar.push({ id: p.id, handle: p.handle, title: p.title, gemelo: gemelo.handle,
                                motivo: t ? "mismo título" : "SKU compartido" });
    else sinGemelo.push(p);
  }

  console.log(`Carga ${lote}: ${delLote.length} activos · con gemelo: ${archivar.length} · sin gemelo: ${sinGemelo.length}`);
  for (const a of archivar.slice(0, 10)) console.log(`  ${a.handle.padEnd(30)} -> gemelo ${a.gemelo.padEnd(30)} (${a.motivo})`);
  if (archivar.length > 10) console.log(`  … y ${archivar.length - 10} más`);
  if (sinGemelo.length) {
    console.log("\nSin gemelo, NO se archivan:");
    for (const p of sinGemelo) console.log(`  ${p.handle}  ${p.title}`);
  }

  const lista = path.resolve(`data/archivados-${lote}.csv`);
  fs.writeFileSync(lista, "﻿id,handle,title,gemelo,motivo\n" +
    archivar.map((a) => [a.id, a.handle, a.title, a.gemelo, a.motivo].map(celda).join(",")).join("\n") + "\n");
  console.log(`\nLista: ${lista}`);

  if (!aplicar) { console.log("Simulación. Agrega --aplicar para archivarlos."); return; }
  const fallidos = await cambiarEstado(tk, archivar.map((a) => a.id), "ARCHIVED");
  console.log(`Archivados: ${archivar.length - fallidos} · Fallidos: ${fallidos}`);
  console.log(`Para deshacerlo: npm run shopify:archivar -- --revertir data/archivados-${lote}.csv --aplicar`);
}

if (require.main === module) {
  principal().then(() => process.exit(0)).catch(alFallar);
}
