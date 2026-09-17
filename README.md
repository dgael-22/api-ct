# Middleware SCHU – Shopify – CT Online

Implementación del MVP descrito en la **Especificación Técnica y Guía Operativa**
(María Cecilia Peña Bravo, 27-ago-2026): Node.js + TypeScript + Express 5 +
TypeORM/SQLite, con la librería oficial de Shopify y `fetch` nativo hacia CT.

El contrato de CT sale de su documentación pública:
<https://api.ctonline.mx/documentacion.html>. Lo que esa documentación no dice
queda marcado como **PENDIENTE** en el código; nada se inventa.

---

## Arranca sin nada configurado

```bash
npm install
npm run dev
curl http://localhost:3000/health
```

`npm run dev` corre el TypeScript directo y recarga al guardar. `npm start`
ejecuta el JavaScript ya compilado (`npm run build` primero) — es lo que usa
Railway, no lo que quieres en local.

> **Node 24 en Windows:** `better-sqlite3` va fijado en `^12.11.1` porque a
> partir de la 12.2 hay binarios precompilados para Node 24 (`node-v137`). Con
> la 11.x npm intenta compilar con node-gyp y pide Visual Studio con el
> workload de C++. Si ves `gyp ERR! find VS`, es que se instaló una versión
> vieja: borra `node_modules` y vuelve a correr `npm install`.

`/health` responde 200 aunque no haya `.env`, y dice exactamente qué variables
faltan. Cada endpoint que necesita una credencial falla solo, con un **503** que
nombra la variable — no con un error genérico.

Para operar de verdad: `cp .env.example .env` y llenar los valores.

---

## Endpoints

| Método | Ruta | Para qué | RF |
|---|---|---|---|
| GET | `/health` | vivo, y qué está configurado | — |
| GET | `/mappings` | mappings guardados (`?status=confirmed`) | RF-01 |
| POST | `/mappings` | alta o confirmación de un mapping | RF-01 |
| POST | `/inventory/sync` | copia a Shopify la disponibilidad de CT | RF-02, RF-07 |
| POST | `/webhooks/shopify/orders-paid` | recibe la orden pagada | RF-03 |
| GET | `/orders` | órdenes y su relación con CT (`?status=blocked`) | RF-05 |
| POST | `/orders/confirm` | confirma en CT los pedidos pendientes | — |
| POST | `/orders/:shopifyOrderId/retry` | reprocesa una orden `blocked` | RF-04 |
| GET | `/orders/:shopifyOrderId` | una orden | RF-05 |

Todos menos `/health` y el webhook piden la cabecera `x-api-key`.

**El mapping se busca por variante**, que siempre viene en la orden. El SKU es
opcional (hay artículos sin él) y sólo se usa si una línea no trae variante.
`shopifyVariantId` se acepta como número o como `gid://shopify/ProductVariant/…`.

**Reintentar es manual.** Una orden `blocked` nunca llegó a CT: cuando se
resuelve la causa (se confirma el mapping, llegan las credenciales) se
reprocesa con `POST /orders/:id/retry`, con la copia de la orden que se guardó
al recibirla. No hay reintento automático porque en ese lapso alguien pudo
haberla surtido por otro lado.

### Confirmar un mapping es un acto humano

```bash
curl -X POST localhost:3000/mappings -H 'Content-Type: application/json' -d '{
  "shopifyVariantId": "111",
  "shopifySku": "SCHU-001",
  "ctSku": "CT-49382",
  "partNumber": "ABC-16GB",
  "status": "confirmed",
  "confirmedBy": "diego"
}'
```

Sin `confirmedBy` la API rechaza la confirmación. Que el SKU exista en los dos
sistemas no basta: el caso del ETS —`ABC-16GB` que en CT es de 8 GB— es
justamente lo que este paso evita.

---

## El pedido de CT son DOS pasos

La documentación de CT es clara en algo que el ETS no alcanzó a recoger, porque
se escribió antes de conocer el API real: crear el pedido **no** cierra la
compra.

```
POST /pedido  ->  folio  ->  POST /pedido/confirmar   (dentro de 48 h)
```

Si nadie confirma en esa ventana, **CT cancela el pedido solo**. Por eso
`OrderService` confirma en cuanto crea —la orden de Shopify ya venía pagada— y
guarda `sentAt`, `confirmDeadline` y `confirmedAt`. Si la confirmación falla, la
orden queda en `sent` y la recoge:

```bash
npm run confirm:orders        # o POST /orders/confirm
```

que además avisa de los pedidos a menos de 6 h de vencer. En producción se
programa cada 15 minutos: sin eso, un corte de red de un minuto convierte una
venta en un pedido cancelado sin que nadie se entere.

Estados de una orden:

| Estado | Qué significa |
|---|---|
| `received` | llegó el webhook; falta configuración o no se ha enviado |
| `sent` | creada en CT, **esperando confirmación** |
| `accepted` | confirmada: la compra quedó en firme |
| `rejected` | CT la rechazó |
| `expired` | se pasó la ventana y CT la canceló |
| `uncertain` | respuesta incierta: **no reintentar**, verificar en CT primero |

---

## Las tres detenciones indispensables

| Situación | Estado de la orden | Comportamiento |
|---|---|---|
| Variante sin mapping confirmado | se detiene antes de llamar a CT | no se envía nada |
| CT rechaza o no hay stock | `rejected` | no se marca surtida ni se reintenta |
| Respuesta incierta (timeout) | `uncertain` | **nadie reintenta**: primero se verifica en `/pedido/listar` |

`crearPedido` tiene los reintentos en **0** a propósito. Si la conexión se corta
no sabemos si CT procesó la compra, y repetir a ciegas la duplica.

La idempotencia la da `OrderMapping.externalReference`: se deriva del ID de la
orden de Shopify, así que la misma orden siempre produce el mismo `idPedido` de
CT y un reintento no crea un segundo pedido.

---

## Estructura

```
src/
  entities/     ProductMapping.ts, OrderMapping.ts
  services/     CtClient.ts, ShopifyClient.ts,
                InventorySyncService.ts, OrderService.ts
  routes/       shopifyWebhooks.ts
  scripts/      inspectCsv.ts, importConfirmedMappings.ts, syncInventory.ts
  config/       env.ts
  data-source.ts
  app.ts
```

Comandos: `npm run dev` (recarga), `npm start`, `npm run typecheck`,
`npm run inspect:csv -- archivo.csv`, `npm run import:mappings -- mapeo.csv`,
`npm run sync:inventory`.

---

## El webhook

Shopify firma cada aviso. Se valida el **HMAC-SHA256 del cuerpo crudo** contra
`SHOPIFY_WEBHOOK_SECRET`, comparado en tiempo constante, antes de leer el
contenido. Firma que no coincide: `401` y nada más.

Se responde `200` de inmediato y el trabajo sigue en segundo plano: si el
middleware tarda, Shopify reintenta, y cada reintento sería un pedido de más.

En local, `ngrok` publica el endpoint para que Shopify lo alcance.

---

## Probar el circuito completo sin CT

CT tarda en autorizar la integración, y esperar a eso dejaría el flujo entero
sin probar hasta el último día. Para evitarlo hay un CT de mentiras:

```bash
CT_MODO=simulado npm run dev
```

Responde con las mismas formas que documenta CT, así que **todo lo demás es
real**: el webhook firmado, la traducción de líneas, la persistencia, la
confirmación, el metafield en la orden y el inventario de vuelta en Shopify.
Cuando lleguen las credenciales, se cambia `CT_MODO=real` y lo mismo apunta al
sandbox.

Tres cosas lo hacen útil y no un simple `return {}`:

- **El stock es determinista.** La misma clave siempre da la misma cantidad, así
  que las pruebas son repetibles.
- **Un pedido confirmado descuenta stock.** Por eso la resincronización (RF-07)
  muestra un cambio de verdad en vez de repetir el mismo número.
- **Los casos feos se fuerzan a voluntad**, que es justo lo que con CT real no
  se puede:

| `CT_SIMULADO_ESCENARIO` | Qué provoca | Estado esperado |
|---|---|---|
| `ok` (por omisión) | acepta y confirma | `accepted` |
| `sin_stock` | existencias en 0 | `rejected` |
| `rechazo` | CT devuelve errores | `rejected` |
| `caida` | la conexión se corta | `uncertain` |

En modo simulado, `/health` lo dice (`ct.simulado: true`), el arranque lo
anuncia con un recuadro y las credenciales de CT dejan de aparecer como
faltantes, porque no se usan.

**Nunca lo dejes encendido contra la tienda real**: lo que "vende" no existe.

---

## Probarla con Bruno o Postman

Nivel "manual" de la sección 9 del ETS. Lo automatizado va aparte:

```bash
npm test               # flujo del pedido y autenticación, sin red ni base
npm run simular:ct     # servidor real + CT simulado en los cuatro escenarios
```

`simular:ct` apaga Shopify y usa una base temporal: es seguro aunque el `.env`
apunte a la tienda real. Por lo mismo, no prueba las escrituras a Shopify.

Las dos colecciones son para probar a mano.

**Bruno** — abre la carpeta `bruno/` como colección y elige el environment
`local`. Las 11 peticiones van numeradas y traen sus asserts.

**Postman** — importa `postman/SCHU-CT.postman_collection.json` y
`postman/SCHU-CT.postman_environment.json`. Cinco carpetas por nivel, con
tests y `console.log` de lo importante.

Córrelas **en orden**: las de mapping preparan el dato que usa el webhook.

`/mappings`, `/inventory` y `/orders` piden la cabecera `x-api-key`: las
colecciones la mandan con `admin_api_key` del environment (por defecto
`clave_de_prueba`), que debe ser igual a `ADMIN_API_KEY` del `.env`.

Los niveles 1 a 3 no necesitan credenciales de Shopify ni de CT. Para el webhook hace falta
`SHOPIFY_WEBHOOK_SECRET` en el `.env`, igual al `webhook_secret` del
environment (por defecto `secreto_de_prueba`). La firma HMAC la calcula un
script de pre-request; no hay que generarla a mano.

Si no quieres las colecciones en el repo, borra las dos carpetas: no hay código
que dependa de ellas.

---

## Lo que falta confirmar con CT

| # | Pendiente | Dónde pega |
|---|---|---|
| 1 | Autorización de la integración y token | todo |
| 2 | Qué campo de existencias es el **vendible** | `InventorySyncService` resta 1 de margen mientras tanto |
| 3 | Qué almacén surte a León | `CT_ALMACEN` |
| 4 | Si el precio incluye IVA | publicación de precios |
| 5 | Catálogo de `tipoPago` y uso de `cfdi` | `OrderService` usa `"99"` y `"G01"` del ejemplo |
| 6 | Vigencia real del token | `CtClient` lo renueva cada hora y ante 401 |
| 7 | Catálogo de errores de CT | manejo de rechazos |

Mientras el punto 1 no se resuelva, `POST /cliente/token` devuelve 401 aunque
los datos sean correctos: la documentación de CT dice que un representante debe
autorizar la integración primero.

---

## Desplegar en Railway

Shopify necesita una **URL pública con HTTPS** para mandar los webhooks. Railway
la da de inmediato, y su plan inicial trae crédito mensual que alcanza de sobra
para desarrollo y pruebas de sincronización. Es la ruta más corta para dejar de
depender de `ngrok` y de que tu laptop esté encendida.

### 1. Sube el repo

```bash
git remote add origin https://github.com/<tu-usuario>/api-ct.git
git push -u origin main
```

### 2. Crea el proyecto

En Railway: **New Project → Deploy from GitHub repo** y elige el repo. Detecta
Node solo y lee `railway.json`, que ya trae:

- `buildCommand`: `npm run build`
- `startCommand`: `npm run migration:run && npm start`
- `healthcheckPath`: `/health`

### 3. Agrega PostgreSQL

**New → Database → Add PostgreSQL**, en el mismo proyecto.

### 4. Variables del servicio

`PORT` la inyecta Railway; no la pongas. `DATABASE_URL` se referencia al
servicio de Postgres:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
DB_SSL=false
NODE_ENV=production
CONFIRM_INTERVAL_MINUTES=15
ADMIN_API_KEY=...

SHOPIFY_SHOP_DOMAIN=schuprueba-dev.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_API_VERSION=2025-07
SHOPIFY_ACCESS_TOKEN=...
SHOPIFY_WEBHOOK_SECRET=...
SHOPIFY_LOCATION_ID=...

CT_BASE_URL=https://api.ctonline.mx
CT_EMAIL=...
CT_CLIENTE=...
CT_RFC=...
CT_ALMACEN=...
```

`DB_SSL=false` porque por la red interna de Railway
(`postgres.railway.internal`) no se usa TLS. Si conectas por la URL pública,
ponlo en `true`.

`ADMIN_API_KEY` protege `/mappings`, `/inventory` y `/orders` (cabecera
`x-api-key`). Sin ella esos endpoints responden 503: fallan cerrados. Genera una
larga con
`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

`APP_BASE_URL` no hace falta: se deduce de `RAILWAY_PUBLIC_DOMAIN`.

`CONFIRM_INTERVAL_MINUTES=15` **sí importa**. En Railway no hay nadie corriendo
`npm run confirm:orders` a mano, y CT cancela por su cuenta lo que no se
confirme en 48 h. Con esto el propio servicio lo hace cada cuarto de hora.

### 5. Genera el dominio y registra el webhook

En **Settings → Networking → Generate Domain**. Te queda algo como
`https://api-ct-production.up.railway.app`.

Comprueba:

```bash
curl https://tu-dominio.up.railway.app/health
```

Y en Shopify registra el webhook `orders/paid` apuntando a:

```
https://tu-dominio.up.railway.app/webhooks/shopify/orders-paid
```

### Notas del despliegue

- **Las migraciones corren solas** en cada deploy (`migration:run` antes de
  `start`). Son idempotentes: TypeORM lleva su tabla de aplicadas.
- **El esquema nunca se crea con `synchronize`.** En producción eso puede
  alterar o borrar columnas sin avisar, y aquí hay órdenes reales.
- **`better-sqlite3` es dependencia opcional.** Solo se usa en local; si su
  compilación nativa fallara en el build de Railway, el deploy sigue porque ahí
  el motor es Postgres.
- **El plan inicial de Railway duerme el servicio si no hay tráfico.** El primer
  webhook después de un rato despierta el contenedor y puede tardar unos
  segundos; Shopify reintenta, y la idempotencia por `externalReference` evita
  el pedido doble. Para operación real conviene un plan que no duerma.
- Los secretos viven en las Variables de Railway, no en el repo. El `.env` está
  en `.gitignore`.

Cuando el volumen lo justifique —y no antes, como dice la sección 13 del ETS—
el temporizador interno se cambia por un servicio cron aparte o una cola
(BullMQ/Redis), y una sola instancia por varias.
