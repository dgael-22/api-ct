/**
 * src/services/catalogoCt.ts
 * ==========================
 * Lo que no necesita red para importar productos de CT a Shopify:
 * normalizar el catálogo, filtrarlo y calcular el precio de venta.
 *
 * PENDIENTE con CT: el formato del catálogo con descripción e imágenes. La
 * documentación pública sólo muestra existencias y precios. Por eso
 * `normalizarProductoCt` acepta varios nombres para cada campo; cuando CT
 * entregue el archivo real, se ajustan las listas de ALIAS y nada más.
 */
import { env } from "../config/env";

/** Un artículo de CT, ya con nombres de campo propios. */
export interface ProductoCt {
  clave: string;
  nombre: string;
  descripcion: string | null;
  marca: string | null;
  categoria: string | null;
  subcategoria: string | null;
  imagenes: string[];
  numeroParte: string | null;
  codigoBarras: string | null;
  /** Precio y moneda del archivo, si los trae. El importador los reemplaza por los de la API. */
  precio: number | null;
  moneda: string | null;
}

const ALIAS: Record<Exclude<keyof ProductoCt, "imagenes" | "precio">, string[]> = {
  clave: ["clave", "codigo", "codigoCT", "clave_ct", "sku"],
  nombre: ["nombre", "titulo", "title", "descripcion_corta", "descripcionCorta", "name"],
  descripcion: ["descripcion_larga", "descripcionLarga", "descripcion", "description", "detalle"],
  marca: ["marca", "brand", "fabricante"],
  categoria: ["categoria", "category", "linea"],
  subcategoria: ["subcategoria", "subcategory", "sublinea"],
  numeroParte: ["numParte", "numeroParte", "no_parte", "partNumber", "modelo", "mpn"],
  codigoBarras: ["upc", "ean", "codigoBarras", "codigo_barras", "barcode"],
  moneda: ["moneda", "currency"],
};
const ALIAS_IMAGEN = ["imagenes", "imagen", "images", "image", "urlImagen", "foto", "fotos"];
const ALIAS_PRECIO = ["precio", "price", "precioLista"];

function texto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const t = String(valor).trim();
  return t ? t : null;
}

function primero(crudo: Record<string, unknown>, nombres: string[]): string | null {
  // Sin distinguir mayúsculas: "Marca" y "marca" son el mismo campo.
  const llaves = new Map(Object.keys(crudo).map((k) => [k.toLowerCase(), k]));
  for (const nombre of nombres) {
    const llave = llaves.get(nombre.toLowerCase());
    const valor = llave ? texto(crudo[llave]) : null;
    if (valor) return valor;
  }
  return null;
}

function imagenesDe(crudo: Record<string, unknown>): string[] {
  const llaves = new Map(Object.keys(crudo).map((k) => [k.toLowerCase(), k]));
  const urls: string[] = [];
  for (const nombre of ALIAS_IMAGEN) {
    const llave = llaves.get(nombre.toLowerCase());
    if (!llave) continue;
    const valor = crudo[llave];
    const lista = Array.isArray(valor) ? valor : String(valor ?? "").split(/[\s,;|]+/);
    for (const v of lista) {
      const url = typeof v === "object" && v ? texto((v as Record<string, unknown>).url) : texto(v);
      if (url && /^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/** Devuelve null si el renglón no trae clave o nombre: sin eso no hay producto. */
export function normalizarProductoCt(crudo: Record<string, unknown>): ProductoCt | null {
  const clave = primero(crudo, ALIAS.clave);
  const nombre = primero(crudo, ALIAS.nombre);
  if (!clave || !nombre) return null;
  const precio = Number(primero(crudo, ALIAS_PRECIO));
  let descripcion = primero(crudo, ALIAS.descripcion);
  if (descripcion === nombre) descripcion = null;
  return {
    clave,
    nombre,
    descripcion,
    marca: primero(crudo, ALIAS.marca),
    categoria: primero(crudo, ALIAS.categoria),
    subcategoria: primero(crudo, ALIAS.subcategoria),
    imagenes: imagenesDe(crudo),
    numeroParte: primero(crudo, ALIAS.numeroParte),
    codigoBarras: primero(crudo, ALIAS.codigoBarras),
    precio: precio > 0 ? precio : null,
    moneda: primero(crudo, ALIAS.moneda)?.toUpperCase() ?? null,
  };
}

export interface FiltroCatalogo {
  categorias?: string[];
  marcas?: string[];
  claves?: string[];
  limite?: number;
}

const igual = (a: string | null, lista: string[]) =>
  !!a && lista.some((b) => b.trim().toLowerCase() === a.trim().toLowerCase());

/** Filtra por categoría (o subcategoría), marca y clave. Sin filtros, pasa todo. */
export function filtrarCatalogo(productos: ProductoCt[], filtro: FiltroCatalogo): ProductoCt[] {
  const salida = productos.filter((p) =>
    (!filtro.categorias?.length || igual(p.categoria, filtro.categorias) || igual(p.subcategoria, filtro.categorias)) &&
    (!filtro.marcas?.length || igual(p.marca, filtro.marcas)) &&
    (!filtro.claves?.length || igual(p.clave, filtro.claves))
  );
  return filtro.limite && filtro.limite > 0 ? salida.slice(0, filtro.limite) : salida;
}

export interface ReglasPrecio {
  margenPct: number;
  ivaPct: number;
  /** PENDIENTE con CT: si su precio ya trae IVA. Mientras, se asume que no. */
  precioIncluyeIva: boolean;
}

export function reglasPrecio(): ReglasPrecio {
  return {
    margenPct: env.catalogo.margenPct,
    ivaPct: env.catalogo.ivaPct,
    precioIncluyeIva: env.catalogo.precioCtIncluyeIva,
  };
}

/**
 * Precio de venta en pesos: costo de CT (convertido si viene en USD) + margen
 * + IVA, redondeado hacia arriba al peso. Devuelve null si no se puede saber.
 */
export function precioVenta(
  precioCt: number, moneda: string, tipoCambio: number | null, reglas: ReglasPrecio
): number | null {
  if (!(precioCt > 0)) return null;
  const mon = moneda.trim().toUpperCase();
  let costo: number;
  if (mon === "MXN" || mon === "MN" || mon === "PESOS") costo = precioCt;
  else if (mon === "USD" || mon === "US" || mon === "DLS") {
    if (!(tipoCambio && tipoCambio > 0)) return null;
    costo = precioCt * tipoCambio;
  } else return null;

  const conMargen = costo * (1 + reglas.margenPct / 100);
  const final = reglas.precioIncluyeIva ? conMargen : conMargen * (1 + reglas.ivaPct / 100);
  // Pequeña tolerancia: 1234.0000001 no debe subir a 1235.
  return Math.ceil(final - 1e-6);
}

/** Handle estable en Shopify: la misma clave de CT siempre da el mismo producto. */
export function handleCt(clave: string): string {
  const base = clave
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `ct-${base}`;
}

/** Tags que agrupan lo importado, para colecciones y búsqueda en el admin. */
export function tagsCt(p: ProductoCt): string[] {
  const tags = ["ct", "importado-ct"];
  if (p.marca) tags.push(`marca:${p.marca}`);
  if (p.categoria) tags.push(`ct-categoria:${p.categoria}`);
  if (p.subcategoria) tags.push(`ct-subcategoria:${p.subcategoria}`);
  return tags;
}

/** Descripción HTML sencilla y segura (el texto de CT se escapa). */
export function descripcionHtml(p: ProductoCt): string {
  const escapar = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const partes: string[] = [];
  if (p.descripcion) {
    partes.push(...p.descripcion.split(/\n{2,}/).map((b) => `<p>${escapar(b).replace(/\n/g, "<br>")}</p>`));
  }
  const datos: string[] = [];
  if (p.marca) datos.push(`<li><strong>Marca:</strong> ${escapar(p.marca)}</li>`);
  if (p.numeroParte) datos.push(`<li><strong>Modelo / No. de parte:</strong> ${escapar(p.numeroParte)}</li>`);
  if (datos.length) partes.push(`<ul>${datos.join("")}</ul>`);
  return partes.join("\n");
}
