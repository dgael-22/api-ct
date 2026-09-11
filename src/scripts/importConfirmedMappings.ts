/**
 * src/scripts/importConfirmedMappings.ts
 * ======================================
 * Carga mappings desde un CSV ya revisado por una persona.
 *
 *   npm run import:mappings -- ruta/al/mapeo.csv
 *
 * Columnas esperadas (los nombres se aceptan con o sin acentos y en cualquier
 * mayúscula/minúscula):
 *
 *   shopifyVariantId, shopifySku, ctSku, ctProductId, partNumber,
 *   inventoryItemId, locationId, status, confirmedBy, reason
 *
 * Las filas con la columna ctSku vacía se cuentan como "sin llenar" y no
 * entran: son las que todavía esperan el código de CT.
 *
 * REGLA: una fila entra como "confirmed" SÓLO si el CSV lo dice explícitamente
 * y trae confirmedBy. Todo lo demás entra como "pending". El script no
 * confirma nada por su cuenta.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "csv-parse/sync";
import { inicializarBd, repositorios } from "../data-source";

const ruta = process.argv[2];

async function principal(): Promise<void> {
  if (!ruta) {
    console.error("Uso: npm run import:mappings -- ruta/al/mapeo.csv");
    process.exit(1);
  }
  const absoluta = path.resolve(ruta);
  if (!fs.existsSync(absoluta)) {
    console.error(`No encuentro ${absoluta}`);
    process.exit(1);
  }

  const filas = parse(fs.readFileSync(absoluta, "utf8"), {
    columns: (cabeceras: string[]) =>
      cabeceras.map((c) => c.trim().replace(/\s+/g, "").toLowerCase()),
    skip_empty_lines: true,
    bom: true,
  }) as Record<string, string>[];

  await inicializarBd();
  const { productos } = repositorios();

  let creados = 0;
  let actualizados = 0;
  let confirmados = 0;
  let omitidos = 0;

  for (const fila of filas) {
    const variantId = (fila["shopifyvariantid"] ?? "").trim();
    const shopifySku = (fila["shopifysku"] ?? "").trim();
    const ctSku = (fila["ctsku"] ?? "").trim();

    // El SKU de Shopify puede venir vacío: en la tienda hay artículos de
    // tecnología dados de alta sin SKU. Lo que no puede faltar es la variante
    // y la clave de CT — sin esas dos no hay mapeo que guardar.
    if (!variantId || !ctSku) { omitidos++; continue; }

    const confirmedBy = (fila["confirmedby"] ?? "").trim();
    const pedido = (fila["status"] ?? "").trim().toLowerCase();
    // Sólo se confirma si el CSV lo dice Y dice quién.
    const status = pedido === "confirmed" && confirmedBy ? "confirmed" : (pedido === "conflict" ? "conflict" : "pending");
    if (status === "confirmed") confirmados++;

    const existente = await productos.findOne({ where: { shopifyVariantId: variantId } });
    const mapeo = existente ?? productos.create({ shopifyVariantId: variantId, shopifySku, ctSku });

    mapeo.shopifySku = shopifySku;
    mapeo.ctSku = ctSku;
    mapeo.ctProductId = (fila["ctproductid"] ?? "").trim() || null;
    mapeo.partNumber = (fila["partnumber"] ?? "").trim() || null;
    mapeo.inventoryItemId = (fila["inventoryitemid"] ?? "").trim() || null;
    mapeo.locationId = (fila["locationid"] ?? "").trim() || null;
    mapeo.status = status as never;
    mapeo.reason = (fila["reason"] ?? "").trim() || null;
    mapeo.confirmedBy = confirmedBy || null;

    await productos.save(mapeo);
    existente ? actualizados++ : creados++;
  }

  console.log(`Filas leídas:  ${filas.length}`);
  console.log(`Creados:       ${creados}`);
  console.log(`Actualizados:  ${actualizados}`);
  console.log(`Confirmados:   ${confirmados}`);
  console.log(`Sin llenar:    ${omitidos} (sin variante o sin clave de CT)`);
  if (confirmados === 0 && creados + actualizados > 0) {
    console.log(
      "\nNinguna fila quedó confirmada. Para confirmar hay que poner\n" +
      "status=confirmed y confirmedBy=<tu nombre> en el CSV. Mientras estén\n" +
      "en pending, el middleware no las usa para vender ni sincronizar."
    );
  }
}

principal()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Falló la importación:", (e as Error).message);
    process.exit(1);
  });
