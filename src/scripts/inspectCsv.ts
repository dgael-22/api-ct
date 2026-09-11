/**
 * src/scripts/inspectCsv.ts
 * =========================
 * Paso 2 del tutorial (sección 10 del ETS): abrir y revisar los CSV ANTES de
 * diseñar tablas. No modifica nada: dice qué columnas trae el archivo y qué
 * problemas tiene, para que el mapping se decida sobre datos reales.
 *
 *   npm run inspect:csv -- ruta/al/catalogo.csv
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "csv-parse/sync";

const ruta = process.argv[2];

if (!ruta) {
  console.error("Uso: npm run inspect:csv -- ruta/al/archivo.csv");
  process.exit(1);
}

const absoluta = path.resolve(ruta);
if (!fs.existsSync(absoluta)) {
  console.error(`No encuentro ${absoluta}`);
  process.exit(1);
}

const filas = parse(fs.readFileSync(absoluta, "utf8"), {
  columns: true,
  skip_empty_lines: true,
  bom: true,
  relax_column_count: true,
}) as Record<string, string>[];

console.log(`Archivo:  ${absoluta}`);
console.log(`Filas:    ${filas.length}`);

const columnas = filas.length ? Object.keys(filas[0]) : [];
console.log(`Columnas: ${columnas.length}`);
columnas.forEach((c) => console.log(`  · ${c}`));

function buscar(patron: RegExp): string | undefined {
  return columnas.find((c) => patron.test(c));
}

const colSku = buscar(/variant sku|^sku$/i);
const colParte = buscar(/n[uú]mero de parte|part.?number|modelo/i);
const colEan = buscar(/ean|upc|barcode/i);

console.log("\n--- Columnas que el mapping necesita ---");
console.log(`SKU:              ${colSku ?? "(no encontrada)"}`);
console.log(`Número de parte:  ${colParte ?? "(no encontrada)"}`);
console.log(`EAN / UPC:        ${colEan ?? "(no encontrada)"}`);

if (!colSku) {
  console.error("\nSin columna de SKU no hay mapping posible.");
  process.exit(1);
}

const vistos = new Map<string, number>();
let vacios = 0;
let conEspacios = 0;

for (const fila of filas) {
  const crudo = fila[colSku] ?? "";
  if (!crudo.trim()) { vacios++; continue; }
  if (crudo !== crudo.trim()) conEspacios++;
  const clave = crudo.trim().toUpperCase();
  vistos.set(clave, (vistos.get(clave) ?? 0) + 1);
}

const duplicados = [...vistos.entries()].filter(([, n]) => n > 1);

console.log("\n--- Calidad del SKU ---");
console.log(`SKU únicos:                 ${vistos.size}`);
console.log(`Filas sin SKU:              ${vacios}`);
console.log(`SKU con espacios sobrantes: ${conEspacios}`);
console.log(`SKU duplicados:             ${duplicados.length}`);

if (duplicados.length) {
  console.log("\nPrimeros duplicados (un SKU no puede apuntar a dos productos):");
  duplicados.slice(0, 20).forEach(([clave, n]) => console.log(`  ${clave} × ${n}`));
}

console.log(
  "\nRecuerda: que el SKU exista en los dos sistemas NO confirma el mapeo.\n" +
  "Hay que comparar marca, modelo, número de parte y variante antes de\n" +
  "marcar un mapping como 'confirmed'."
);
