/**
 * src/scripts/importarCatalogoCt.ts
 * =================================
 * Importa a Shopify productos del catálogo que entregue CT (JSON o CSV).
 *
 *   npm run ct:importar -- catalogo.json --resumen                  (qué trae el archivo)
 *   npm run ct:importar -- catalogo.json --categoria Laptops --limite 5   (simulación)
 *   npm run ct:importar -- catalogo.json --categoria Laptops --aplicar
 *
 * Filtros (se pueden repetir): --categoria, --marca, --clave. --limite N.
 *
 * Por defecto manda los productos a la API de producción, que es la que
 * puede hablar con CT (CT sólo acepta la IP registrada). Necesita en el .env:
 *   API_REMOTA_URL=https://api-ct-production.up.railway.app
 *   API_REMOTA_CLAVE=<la ADMIN_API_KEY de producción>
 *
 * --local corre la importación en esta máquina, contra la base y el CT del
 * .env (útil con CT_MODO=simulado para probar).
 *
 * Sin --aplicar sólo simula: consulta precios a CT y dice qué haría.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "csv-parse/sync";
import { env } from "../config/env";
import { inicializarBd, repositorios } from "../data-source";
import { filtrarCatalogo, normalizarProductoCt, type ProductoCt } from "../services/catalogoCt";
import { ImportadorCt, type ResultadoImportacion } from "../services/ImportadorCt";
import { ShopifyClient } from "../services/ShopifyClient";
import { crearClienteCt } from "../services/ctFactory";

const LOTE = 50;

const CON_VALOR = ["--categoria", "--marca", "--clave", "--limite"];

function argumentos() {
  const args = process.argv.slice(2);
  const valores: Record<string, string[]> = {};
  const sueltos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (CON_VALOR.includes(args[i])) (valores[args[i]] ??= []).push(args[++i] ?? "");
    else if (!args[i].startsWith("--")) sueltos.push(args[i]);
  }
  return {
    archivo: sueltos[0],
    categorias: valores["--categoria"] ?? [],
    marcas: valores["--marca"] ?? [],
    claves: valores["--clave"] ?? [],
    limite: Number(valores["--limite"]?.[0]) || undefined,
    aplicar: args.includes("--aplicar"),
    local: args.includes("--local"),
    resumen: args.includes("--resumen"),
  };
}

/** Acepta un arreglo, { productos: [...] } o el primer arreglo que traiga el objeto. */
function leerCatalogo(ruta: string): Record<string, unknown>[] {
  const texto = fs.readFileSync(ruta, "utf8");
  if (/\.csv$/i.test(ruta)) {
    return parse(texto, { columns: true, skip_empty_lines: true, bom: true }) as Record<string, unknown>[];
  }
  const datos = JSON.parse(texto.replace(/^﻿/, ""));
  if (Array.isArray(datos)) return datos;
  const arreglo = Object.values(datos ?? {}).find(Array.isArray);
  if (!arreglo) throw new Error("El JSON no trae ninguna lista de productos.");
  return arreglo as Record<string, unknown>[];
}

function top(productos: ProductoCt[], campo: "categoria" | "marca", n = 15): string {
  const cuenta = new Map<string, number>();
  for (const p of productos) cuenta.set(p[campo] ?? "(sin dato)", (cuenta.get(p[campo] ?? "(sin dato)") ?? 0) + 1);
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `    ${String(v).padStart(6)}  ${k}`).join("\n");
}

async function remoto(lote: ProductoCt[], aplicar: boolean): Promise<ResultadoImportacion[]> {
  const url = (process.env.API_REMOTA_URL || "https://api-ct-production.up.railway.app").replace(/\/$/, "");
  const clave = process.env.API_REMOTA_CLAVE;
  if (!clave) throw new Error("Falta API_REMOTA_CLAVE en el .env (la ADMIN_API_KEY de producción).");
  const r = await fetch(`${url}/catalogo/ct/importar`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": clave },
    body: JSON.stringify({ productos: lote, aplicar }),
  });
  const datos = await r.json().catch(() => null) as { resultados?: ResultadoImportacion[]; detalle?: string; error?: string } | null;
  if (!r.ok || !datos?.resultados) {
    throw new Error(`La API respondió ${r.status}: ${datos?.detalle ?? datos?.error ?? "sin detalle"}`);
  }
  return datos.resultados;
}

async function principal(): Promise<number> {
  const a = argumentos();
  if (!a.archivo) {
    console.error("Uso: npm run ct:importar -- <catalogo.json|.csv> [--categoria X] [--marca Y] [--clave Z] [--limite N] [--resumen] [--aplicar] [--local]");
    return 1;
  }
  const ruta = path.resolve(a.archivo);
  const crudos = leerCatalogo(ruta);
  const validos = crudos.map(normalizarProductoCt).filter((p): p is ProductoCt => p !== null);
  const elegidos = filtrarCatalogo(validos, a);

  console.log(`Archivo: ${ruta}`);
  console.log(`Renglones: ${crudos.length} · válidos: ${validos.length} · elegidos con los filtros: ${elegidos.length}`);
  if (a.resumen || elegidos.length === 0) {
    const muestra = elegidos.length ? elegidos : validos;
    console.log(`\n  Categorías:\n${top(muestra, "categoria")}\n\n  Marcas:\n${top(muestra, "marca")}`);
    const conImagen = muestra.filter((p) => p.imagenes.length).length;
    console.log(`\n  Con imagen: ${conImagen} de ${muestra.length} · con descripción: ${muestra.filter((p) => p.descripcion).length}`);
    if (validos.length < crudos.length) {
      console.log(`\n  ${crudos.length - validos.length} renglones sin clave o nombre. Campos del primero: ${Object.keys(crudos[0] ?? {}).join(", ")}`);
    }
    return 0;
  }

  console.log(a.aplicar ? "\nMODO: APLICAR (escribe en Shopify)\n" : "\nMODO: simulación (no escribe nada)\n");
  const resultados: ResultadoImportacion[] = [];

  if (a.local) {
    await inicializarBd();
    const importador = new ImportadorCt(crearClienteCt(), new ShopifyClient(), repositorios().productos);
    resultados.push(...await importador.importar(elegidos, { aplicar: a.aplicar, pausaMs: env.ct.pausaMs }));
  } else {
    for (let i = 0; i < elegidos.length; i += LOTE) {
      const lote = elegidos.slice(i, i + LOTE);
      process.stdout.write(`  lote ${i / LOTE + 1} (${lote.length})… `);
      const parte = await remoto(lote, a.aplicar);
      resultados.push(...parte);
      console.log("listo");
      if (parte.length < lote.length) break; // la API se detuvo (CT limitó o sin conexión)
    }
  }

  console.log("");
  for (const r of resultados) {
    const precio = r.precioVenta !== null ? `$${r.precioVenta.toLocaleString("es-MX")}` : "—";
    const costo = r.costo !== null ? `${r.costo} ${r.moneda}` : "—";
    console.log(
      `${r.accion.padEnd(10)} ${r.clave.padEnd(14)} venta ${precio.padStart(10)} · costo ${costo.padEnd(14)} · ` +
      `existencia ${r.existencia ?? "—"}  ${r.nombre.slice(0, 50)}` + (r.motivo ? `\n           ↳ ${r.motivo}` : "")
    );
  }
  const cuenta = (x: string) => resultados.filter((r) => r.accion === x).length;
  console.log(
    `\nCrear: ${cuenta("crear")} · Actualizar: ${cuenta("actualizar")} · ` +
    `Omitidos: ${cuenta("omitir")} · Errores: ${cuenta("error")} · Sin procesar: ${elegidos.length - resultados.length}`
  );
  if (a.aplicar && cuenta("crear")) {
    console.log("Los productos nuevos quedaron en BORRADOR: revísalos en Shopify y actívalos en la tienda en línea.");
  }
  return cuenta("error") ? 1 : 0;
}

principal()
  .then((codigo) => process.exit(codigo))
  .catch((e) => {
    console.error("Falló la importación:", (e as Error).message);
    process.exit(1);
  });
