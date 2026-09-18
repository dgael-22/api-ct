/**
 * src/scripts/shopifyDirecciones.ts
 * =================================
 * ¿Dónde escriben la colonia los clientes? Shopify no tiene ese campo y CT lo
 * exige, así que este comando mira las direcciones de envío de las últimas
 * órdenes y dice qué campos vienen llenos y cómo se traducirían a CT.
 *
 *   npm run shopify:direcciones              (últimas 50 órdenes)
 *   npm run shopify:direcciones -- 200
 *   npm run shopify:direcciones -- 50 --detalle    (muestra cada dirección)
 *
 * Sólo LEE. Sin `--detalle` no imprime datos de clientes, sólo el conteo.
 */
import { direccionDeEnvio } from "../routes/shopifyWebhooks";
import { camposFaltantesDeEnvio } from "../services/OrderService";
import { alFallar, gql, token } from "./_shopify";

interface Direccion {
  address1: string | null; address2: string | null; company: string | null;
  city: string | null; province: string | null; zip: string | null; phone: string | null;
}

const ORDENES = `
query ordenes($n: Int!, $cursor: String) {
  orders(first: $n, after: $cursor, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      name
      shippingAddress { address1 address2 company city province zip phone }
    }
  }
}`;

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const cuantas = Number(args.find((a) => !a.startsWith("--"))) || 50;
  const detalle = args.includes("--detalle");

  const tk = await token();
  const ordenes: { name: string; shippingAddress: Direccion | null }[] = [];
  let cursor: string | null = null;
  while (ordenes.length < cuantas) {
    const d: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: typeof ordenes } } =
      await gql(tk, ORDENES, { n: Math.min(100, cuantas - ordenes.length), cursor });
    ordenes.push(...d.orders.nodes);
    if (!d.orders.pageInfo.hasNextPage) break;
    cursor = d.orders.pageInfo.endCursor;
  }

  const conDireccion = ordenes.filter((o) => o.shippingAddress);
  if (!conDireccion.length) {
    console.log(`Revisé ${ordenes.length} órdenes y ninguna trae dirección de envío.`);
    return;
  }

  const cuenta = { company: 0, address2: 0, numeroEnCalle: 0, telefono: 0, cp: 0, completas: 0 };
  const faltantes = new Map<string, number>();

  for (const o of conDireccion) {
    const d = o.shippingAddress as Direccion;
    if (String(d.company ?? "").trim()) cuenta.company++;
    if (String(d.address2 ?? "").trim()) cuenta.address2++;
    if (/\d/.test(String(d.address1 ?? ""))) cuenta.numeroEnCalle++;
    if (String(d.phone ?? "").trim()) cuenta.telefono++;
    if (String(d.zip ?? "").trim()) cuenta.cp++;

    const envio = direccionDeEnvio({ shipping_address: d });
    const falta = camposFaltantesDeEnvio(envio);
    if (!falta.length) cuenta.completas++;
    for (const campo of falta) faltantes.set(campo, (faltantes.get(campo) ?? 0) + 1);

    if (detalle) {
      console.log(
        `${o.name}  "${d.address1 ?? ""}" | 2ª línea: "${d.address2 ?? ""}" | empresa: "${d.company ?? ""}"\n` +
        `        -> calle "${envio?.direccion}" · no. ext "${envio?.noExterior}" · int "${envio?.noInterior}" ` +
        `· colonia "${envio?.colonia}"` + (falta.length ? `  ⚠ falta: ${falta.join(", ")}` : "  ✅")
      );
    }
  }

  const pct = (n: number) => `${n} (${Math.round((n / conDireccion.length) * 100)}%)`;
  console.log(`\nÓrdenes revisadas: ${ordenes.length} · con dirección: ${conDireccion.length}\n`);
  console.log(`  Campo "Empresa" lleno:        ${pct(cuenta.company)}   <- hoy de aquí sale la colonia`);
  console.log(`  Segunda línea llena:          ${pct(cuenta.address2)}`);
  console.log(`  Número en la calle:           ${pct(cuenta.numeroEnCalle)}`);
  console.log(`  Teléfono:                     ${pct(cuenta.telefono)}`);
  console.log(`  Código postal:                ${pct(cuenta.cp)}`);
  console.log(`\n  Listas para CT (nada vacío): ${pct(cuenta.completas)}`);
  if (faltantes.size) {
    console.log("\n  Lo que falta, por campo:");
    for (const [campo, n] of [...faltantes].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  ${campo}`);
    }
    console.log("\n  Con estas órdenes, CT no habría podido generar la guía.");
    console.log("  Opciones: pedir la colonia en el checkout, o completarla a mano antes de reintentar.");
  }
}

principal().then(() => process.exit(0)).catch(alFallar);
