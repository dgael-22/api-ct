/**
 * src/scripts/simularCt.mjs
 * =========================
 * Paso 6: punta a punta contra el servidor de verdad con CT_MODO=simulado,
 * en los cuatro escenarios (ok, sin_stock, rechazo, caida).
 *
 *   npm run simular:ct
 *
 * Seguro contra la tienda real: Shopify queda apagado (credenciales vacías,
 * cualquier escritura falla antes de salir a la red) y cada escenario usa una
 * base SQLite desechable en la carpeta temporal del sistema.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RAIZ = process.cwd();
const TMP = os.tmpdir();
const SECRETO = "secreto-de-simulacion";
const CLAVE = "clave-de-simulacion";
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function escenario(nombre, puerto) {
  const bd = path.join(TMP, `sim-${nombre}.sqlite`);
  fs.rmSync(bd, { force: true });
  const env = {
    ...process.env,
    PORT: String(puerto),
    CT_MODO: "simulado",
    CT_SIMULADO_ESCENARIO: nombre,
    DATABASE_URL: `sqlite:${bd}`,
    ADMIN_API_KEY: CLAVE,
    SHOPIFY_WEBHOOK_SECRET: SECRETO,
    // Shopify apagado: cualquier escritura falla antes de salir a la red.
    SHOPIFY_ACCESS_TOKEN: "",
    SHOPIFY_CLIENT_ID: "replace_me",
    SHOPIFY_CLIENT_SECRET: "replace_me",
    CONFIRM_INTERVAL_MINUTES: "0",
  };
  const proc = spawn("npx", ["tsx", "src/app.ts"], { cwd: RAIZ, env, shell: true });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${puerto}`;
  const pedir = async (metodo, ruta, cuerpo, cabeceras = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { "content-type": "application/json", "x-api-key": CLAVE, ...cabeceras },
      body: cuerpo === undefined ? undefined : typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const webhook = (orden, firmaMala = false) => {
    const crudo = JSON.stringify(orden);
    const firma = crypto.createHmac("sha256", firmaMala ? "otro" : SECRETO).update(crudo).digest("base64");
    return pedir("POST", "/webhooks/shopify/orders-paid", crudo, { "X-Shopify-Hmac-Sha256": firma });
  };
  const resumen = (o) => o && `${o.status}${o.ctOrderId ? ` folio=${o.ctOrderId}` : ""}${o.ctStatus ? ` ct="${o.ctStatus}"` : ""}${o.lastResponse ? `
      respuesta: ${String(o.lastResponse).slice(0, 160)}` : ""}`;

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await esperar(500);
    }
    const salud = await pedir("GET", "/health");
    console.log(`\n=== escenario ${nombre} ===`);
    console.log(`health: ${salud.status} ct=${JSON.stringify(salud.json?.ct ?? salud.json?.ctModo ?? "?")}`);

    const sinClave = await fetch(base + "/orders");
    console.log(`GET /orders sin x-api-key -> ${sinClave.status}`);

    const mapeo = await pedir("POST", "/mappings", {
      shopifyVariantId: "111", shopifySku: "SCHU-001", ctSku: "ACCCTX010",
      status: "confirmed", confirmedBy: "simulacion",
    });
    console.log(`alta de mapeo confirmado -> ${mapeo.status}`);

    const orden = (id, variante, sku) => ({
      id, name: `#SIM${id}`, currency: "MXN",
      line_items: [{ sku, variant_id: variante, quantity: 2, price: "100.00" }],
      shipping_address: { first_name: "Prueba", last_name: "Sim", address1: "Calle 1", city: "CDMX",
        province: "CDMX", zip: "01000", phone: "5555555555", company: "Centro" },
    });

    console.log(`webhook con firma falsa -> ${(await webhook(orden(9001, 111, "SCHU-001"), true)).status}`);
    console.log(`webhook orden mapeada   -> ${(await webhook(orden(9001, 111, "SCHU-001"))).status}`);
    console.log(`webhook repetido        -> ${(await webhook(orden(9001, 111, "SCHU-001"))).status}`);
    console.log(`webhook sin mapeo       -> ${(await webhook(orden(9002, 999, "SIN-MAPEO"))).status}`);
    await esperar(2500);

    console.log(`orden 9001: ${resumen((await pedir("GET", "/orders/9001")).json)}`);
    console.log(`orden 9002: ${resumen((await pedir("GET", "/orders/9002")).json)}`);

    const conf = await pedir("POST", "/orders/confirm");
    console.log(`POST /orders/confirm -> ${conf.status} ${JSON.stringify(conf.json)}`);
    console.log(`orden 9001 tras confirmar: ${resumen((await pedir("GET", "/orders/9001")).json)}`);

    const todas = await pedir("GET", "/orders");
    console.log(`registros en la base: ${todas.json?.total}`);
  } finally {
    await new Promise((r) => spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { shell: true }).on("exit", r));
    const lineas = log.split("\n").filter((l) => /webhook|simulad|error/i.test(l)).slice(0, 8);
    if (lineas.length) console.log("log del servidor:\n  " + lineas.join("\n  "));
  }
}

let puerto = 3911;
for (const e of ["ok", "sin_stock", "rechazo", "caida"]) await escenario(e, puerto++);
