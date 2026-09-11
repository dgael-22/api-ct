/**
 * src/scripts/shopifyLocations.ts
 * ===============================
 * Diagnóstico de la conexión con Shopify. No escribe nada: sólo lee.
 *
 *   npm run shopify:locations
 *
 * Hace tres preguntas, en orden, y cada una responde algo distinto:
 *
 *   1. ¿Sirven las credenciales?  -> pide el token con client credentials.
 *   2. ¿Qué permisos tiene ESE token de verdad?  -> pregunta directo a
 *      /admin/oauth/access_scopes.json. Esto es lo que Shopify concedió, no
 *      lo que uno cree haber marcado en el Dev Dashboard. Cuando los dos no
 *      coinciden, es que la versión no se publicó o la app no se reinstaló.
 *   3. ¿Cuáles son las Locations?  -> de ahí sale SHOPIFY_LOCATION_ID.
 *
 * Usa fetch pelón a propósito: así no se mezcla el ruido del SDK con el
 * diagnóstico, y el error que sale es el que mandó Shopify.
 */
import { env } from "../config/env";

/** Los que el middleware usa de verdad. */
const SCOPES_NECESARIOS = [
  "read_products",
  "read_inventory",
  "write_inventory",
  "read_locations",
  "read_orders",
  "write_orders",
];

const RAYA = "-".repeat(68);

async function pedirToken(): Promise<string> {
  if (env.shopify.tokenFijo) {
    console.log("Usando el token fijo de SHOPIFY_ACCESS_TOKEN (app del admin).");
    return env.shopify.tokenFijo;
  }

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

  const texto = await respuesta.text();
  if (!respuesta.ok) {
    console.error(`\nShopify no emitió el token (HTTP ${respuesta.status}).`);
    console.error(texto.slice(0, 400));
    console.error(
      "\nRevisa:\n" +
      `  · Que la app esté INSTALADA en ${env.shopify.dominio}\n` +
      "  · Que SHOPIFY_CLIENT_ID y SHOPIFY_CLIENT_SECRET sean de ESA app"
    );
    process.exit(1);
  }

  const datos = JSON.parse(texto) as { access_token: string };
  return datos.access_token;
}

/**
 * La pregunta que resuelve la discusión: ¿qué permisos trae el token?
 * Este endpoint no necesita ningún scope, así que siempre contesta.
 */
async function scopesDelToken(token: string): Promise<string[] | null> {
  const respuesta = await fetch(
    `https://${env.shopify.dominio}/admin/oauth/access_scopes.json`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  if (!respuesta.ok) return null;
  const datos = (await respuesta.json()) as { access_scopes?: { handle: string }[] };
  return (datos.access_scopes ?? []).map((s) => s.handle);
}

async function locations(token: string): Promise<
  { ok: true; items: { id: string; name: string; isActive: boolean }[] } |
  { ok: false; error: string }
> {
  const respuesta = await fetch(
    `https://${env.shopify.dominio}/admin/api/${env.shopify.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: "query { locations(first: 20) { edges { node { id name isActive } } } }",
      }),
    }
  );

  const texto = await respuesta.text();
  if (!respuesta.ok) return { ok: false, error: `HTTP ${respuesta.status}: ${texto.slice(0, 300)}` };

  const datos = JSON.parse(texto) as {
    data?: { locations?: { edges: { node: { id: string; name: string; isActive: boolean } }[] } };
    errors?: { message: string }[];
  };
  if (datos.errors?.length) return { ok: false, error: datos.errors.map((e) => e.message).join(" | ") };
  return { ok: true, items: (datos.data?.locations?.edges ?? []).map((e) => e.node) };
}

async function principal(): Promise<void> {
  console.log(`Tienda:          ${env.shopify.dominio}`);
  console.log(`Versión de API:  ${env.shopify.apiVersion}\n`);

  // 1 ------------------------------------------------------------------
  const token = await pedirToken();
  console.log(`1. Token obtenido (${token.length} caracteres, no se imprime).`);

  // 2 ------------------------------------------------------------------
  const concedidos = await scopesDelToken(token);
  let faltan: string[] = [];

  if (concedidos === null) {
    console.log("\n2. Shopify no quiso decir los scopes de este token.");
  } else if (concedidos.length === 0) {
    console.log("\n2. El token NO tiene ningún permiso concedido.");
    faltan = SCOPES_NECESARIOS;
  } else {
    console.log(`\n2. Permisos reales de este token:\n   ${concedidos.join("\n   ")}`);
    faltan = SCOPES_NECESARIOS.filter((s) => !concedidos.includes(s));
    if (!faltan.length) console.log("\n   Están todos los que el middleware necesita.");
  }

  if (faltan.length) {
    console.error(
      `\n${RAYA}\n` +
      `FALTAN ESTOS PERMISOS:  ${faltan.join(", ")}\n\n` +
      "Ojo: esta lista es lo que Shopify concedió de verdad. Si en el Dev\n" +
      "Dashboard los ves marcados y aquí no aparecen, es porque el cambio\n" +
      "no llegó a la tienda. Falta una de estas dos:\n\n" +
      "  a) publicar una versión nueva de la app (los scopes viven en la\n" +
      "     versión, no se editan en caliente), o\n" +
      "  b) reinstalar la app en la tienda para aceptar los permisos\n" +
      "     nuevos.\n\n" +
      "Los scopes completos que necesita el middleware:\n\n" +
      `  ${SCOPES_NECESARIOS.join(",")}\n` +
      RAYA
    );
  }

  // 3 ------------------------------------------------------------------
  console.log("\n3. Consultando las Locations…");
  const resultado = await locations(token);

  if (!resultado.ok) {
    console.error(`   Shopify contestó: ${resultado.error}`);
    if (/access denied/i.test(resultado.error)) {
      console.error(
        "   Es el permiso read_locations. Mientras lo arreglas, el ID se\n" +
        "   saca del admin: Configuración -> Ubicaciones -> abrir la\n" +
        "   ubicación; el número que queda al final de la URL es el ID."
      );
    }
    process.exit(1);
  }

  if (!resultado.items.length) {
    console.warn("   La tienda no devolvió ninguna Location.");
    return;
  }

  console.log("");
  for (const l of resultado.items) {
    console.log(`   ${l.id.padEnd(42)}${l.name}${l.isActive ? "" : "  (inactiva)"}`);
  }

  const elegida = resultado.items.find((l) => l.isActive) ?? resultado.items[0];
  console.log(`\nPon esto en tu .env:\n\n  SHOPIFY_LOCATION_ID=${elegida.id}\n`);
}

principal()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFalló:", (e as Error).message);
    process.exit(1);
  });
