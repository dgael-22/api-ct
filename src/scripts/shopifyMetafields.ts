/**
 * src/scripts/shopifyMetafields.ts
 * ================================
 * Crea en Shopify las definiciones de metafield que alimentan los filtros de
 * la tienda: Género, Etapa, Categoría, Ocasión, Cierre, Tacón, Corte, Material.
 *
 *   npm run shopify:metafields                      (simulación)
 *   npm run shopify:metafields -- --aplicar
 *
 * Lee data/vocabulario.json, que escribe schu-catalogo:
 *   python retaguear.py <export.csv> <salida.csv> --vocabulario D:\api-ct\data\vocabulario.json
 *
 * Cada definición lleva sus valores permitidos ("choices"): Shopify rechaza un
 * valor que no esté en la lista, así un "TENIS" nunca abre un filtro aparte.
 * Es idempotente: si la definición ya existe, sólo se corrige lo que difiera.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { alFallar, gql, revisar, token, type ErrorUsuario } from "./_shopify";

export interface Vocabulario {
  metafields: Record<string, { nombre: string; clases: string[]; valores: string[] }>;
}

const TIPO = "list.single_line_text_field";

const LISTAR = `
query defs {
  metafieldDefinitions(first: 50, ownerType: PRODUCT, namespace: "custom") {
    nodes { id key name type { name } validations { name value } access { storefront } }
  }
}`;

const CREAR = `
mutation crear($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id key }
    userErrors { field message code }
  }
}`;

const ACTUALIZAR = `
mutation actualizar($definition: MetafieldDefinitionUpdateInput!) {
  metafieldDefinitionUpdate(definition: $definition) {
    updatedDefinition { id key }
    userErrors { field message code }
  }
}`;

interface Definicion {
  id: string; key: string; name: string; type: { name: string };
  validations: { name: string; value: string }[]; access: { storefront: string };
}

async function principal(): Promise<void> {
  const aplicar = process.argv.includes("--aplicar");
  const ruta = path.resolve(process.argv.find((a) => a.endsWith(".json")) ?? "data/vocabulario.json");
  const voc = JSON.parse(fs.readFileSync(ruta, "utf8")) as Vocabulario;
  console.log(aplicar ? "Modo: APLICAR\n" : "Modo: simulación — agrega --aplicar para escribir.\n");

  const tk = await token();
  const d = await gql<{ metafieldDefinitions: { nodes: Definicion[] } }>(tk, LISTAR);
  const existentes = new Map(d.metafieldDefinitions.nodes.map((n) => [n.key, n]));

  for (const [key, def] of Object.entries(voc.metafields)) {
    const choices = JSON.stringify(def.valores);
    const ya = existentes.get(key);

    if (ya && ya.type.name !== TIPO) {
      console.error(`  ✗ custom.${key} ya existe con tipo ${ya.type.name}. No se toca: revísalo a mano.`);
      continue;
    }
    const actual = ya?.validations.find((v) => v.name === "choices")?.value;
    const igual = ya && ya.name === def.nombre && actual === choices && ya.access.storefront === "PUBLIC_READ";
    if (igual) { console.log(`  = ya está   custom.${key} (${def.nombre}, ${def.valores.length} valores)`); continue; }

    const accion = ya ? "actualizar" : "crear";
    console.log(`  + ${accion.padEnd(10)} custom.${key} (${def.nombre}): ${def.valores.join(", ")}`);
    if (!aplicar) continue;

    const comun = {
      name: def.nombre, namespace: "custom", key, ownerType: "PRODUCT",
      validations: [{ name: "choices", value: choices }],
      access: { storefront: "PUBLIC_READ" },
    };
    if (ya) {
      const r = await gql<{ metafieldDefinitionUpdate: { userErrors: ErrorUsuario[] } }>(
        tk, ACTUALIZAR, { definition: comun });
      revisar(r.metafieldDefinitionUpdate.userErrors);
    } else {
      const r = await gql<{ metafieldDefinitionCreate: { userErrors: ErrorUsuario[] } }>(
        tk, CREAR, { definition: { ...comun, type: TIPO, pin: true,
                                   capabilities: { adminFilterable: { enabled: true } } } });
      revisar(r.metafieldDefinitionCreate.userErrors);
    }
    console.log(`    ✓ ${accion}`);
  }
}

if (require.main === module) {
  principal().then(() => process.exit(0)).catch(alFallar);
}
