# schu-ct-middleware

Middleware entre la tienda Shopify de SCHU y el mayorista **CT Online**.
Node 20+ · TypeScript · Express 5 · TypeORM · SQLite en local, PostgreSQL en Railway.

## Comandos

```bash
npm run dev            # tsx watch (NO verifica tipos)
npm run typecheck      # npx tsc --noEmit — correr SIEMPRE antes de un push
npm test               # flujo del pedido y autenticación, sin red ni base
npm run simular:ct      # paso 6: servidor real + CT simulado, 4 escenarios; Shopify apagado
npm run build && npm start
npm run ct:importar -- <catalogo> [--resumen|--aplicar|--local]   # productos de CT a Shopify
npm run migration:run · inspect:csv -- <csv> · import:mappings -- <csv> · sync:inventory · confirm:orders

npm run shopify:locations                       # token + alcances reales + Locations
npm run shopify:catalogo                        # variantes -> data/catalogo-shopify.csv
npm run shopify:direcciones [-- 200] [--detalle] # qué traen las direcciones de envío (para CT)
npm run shopify:webhook -- <url>                # registra orders/paid
npm run shopify:colecciones -- <csv> [--aplicar] · shopify:menu · shopify:metafields
npm run shopify:organizar [-- --aplicar] [--limite N] [--handle H]   # data/organizacion.csv
npm run shopify:archivar -- --lote AAAA-MM-DD [--aplicar] | --revertir <csv>
```

Los scripts de Shopify son **idempotentes** y sin `--aplicar` sólo simulan. Mantener esas dos propiedades al agregar scripts nuevos.

## Reglas del proyecto

- **`tsx` no verifica tipos.** El build de Railway usa `tsc` y ahí truena. `npx tsc --noEmit` antes de cada push.
- **Si un build falla, Railway conserva el contenedor anterior**: `/health` sigue contestando con el código viejo. La verdad está en Deployments.
- **Ningún valor real vive en el código.** Todo sale de `.env`, que no entra a Git. `.env.example` lleva `replace_me` (ya pasó una vez y GitHub bloqueó el push).
- **Código y comentarios en español.**
- **`crearPedido` nunca reintenta.** Una conexión cortada no debe duplicar una compra.
- **El mapeo se busca por variante** (`normalizarVariante`: gid o número). El SKU sólo es respaldo.
- **Reintentar `blocked` es manual** (`POST /orders/:id/retry`), nunca automático: pudo surtirse por otro lado.
- **CT exige IP fija.** Producción sale por el proxy de `deploy/proxy` (DigitalOcean + Caddy): `CT_BASE_URL` al proxy y `CT_PROXY_KEY`. Nunca destruir el Droplet: su IP es la registrada en CT.
- **Existencias automáticas**: `INVENTORY_SYNC_MINUTES` (0 = apagado), pausa `CT_PAUSA_MS` entre productos; un 429 de CT corta la pasada.
- **Importar catálogo de CT** (`npm run ct:importar`, `POST /catalogo/ct/importar`, `ImportadorCt`): productos nuevos en BORRADOR; si ya los creó el importador, sólo precio y costo; nunca toca claves mapeadas a mano. El formato del catálogo es PENDIENTE con CT: se ajustan los ALIAS de `catalogoCt.ts`.
- **Bitácora** (`registrarEvento`, tabla `bitacora`, `GET /bitacora`): nunca rompe el flujo y nunca recibe secretos.
- **`/mappings`, `/inventory`, `/orders` y `/bitacora` piden `x-api-key`** (`ADMIN_API_KEY`) y fallan cerrados sin ella. `/health` y el webhook (HMAC) no.

## Lo que confirmó CT (17 sep 2026)

| Tema | Respuesta de CT |
|---|---|
| Credenciales | CT envía los datos para generar el token |
| Catálogo y existencias | Por **FTP**: un JSON que se regenera **cada 15 min** (no por la API artículo por artículo) |
| Dropshipping | Si CT genera la guía, **todos los campos del envío son obligatorios**: no acepta vacíos |
| `tipoPago` | **99** con crédito CT, **03** de contado (`CT_TIPO_PAGO`) |
| Almacén | Todos los almacenes están disponibles para envío |
| Token y límites | Token de **24 h**; **100 peticiones por minuto** |
| Pruebas | **Sí hay ambiente de pruebas**; un pedido sin confirmar se cancela solo a las 48 h |

Por eso: el token se renueva a las 23 h, `CtClient` limita a 100 peticiones por minuto, y una orden sin dirección completa se detiene con `envio_incompleto` antes de llegar a CT.

## Las tres detenciones del ETS

Cuando el dato es ambiguo la respuesta correcta es **parar, no adivinar**:

1. Variante sin mapeo confirmado → `blocked` con el motivo; no llega a CT y se reintenta con `/retry`. Igual sin precio de CT o si falla el token antes de enviar (`ct_sin_conexion`).
2. CT rechaza → `rejected`, con el motivo.
3. Respuesta incierta (timeout, red o 5xx) → `uncertain` y **no se reintenta**. Reintentar a ciegas es como CT acaba cobrando dos veces.

## Pedido de CT: dos pasos

`POST /pedido` devuelve un folio y `POST /pedido/confirmar` lo cierra. **CT cancela solo lo que no se confirma en 48 h.** Por eso existen `confirmScheduler` y `npm run confirm:orders`.

`CT_MODO=simulado` cambia `CtClient` por `CtSimulado` sin tocar código. `crearClienteCt()` da **una instancia por proceso**: el simulado guarda sus pedidos en memoria.

## Shopify

- App `schu-ct-middleware` en el Dev Dashboard (org 231834725). Token de client credentials: 24 h, se renueva solo.
- Los alcances viven en la **versión** de la app y la tienda tiene que **aprobarlos reinstalando**. Publicar no basta: sale un `Access denied` confuso. Comprobar con `npm run shopify:locations`.
- Los **alcances opcionales** no sirven: un token de client credentials nunca los trae.

## Catálogo: tags, filtros y duplicados

- `data/organizacion.csv` y `data/vocabulario.json` los genera **schu-catalogo** (`python retaguear.py`). El vocabulario vive allá, en `config/rules.py`.
- Tags = a qué colección entra. Metafields `custom.*` = filtros. Los filtros se activan a mano en Search & Discovery.
- **Nunca un CSV de importación parcial**: se escribe por la API campo por campo.
- Importar con handles distintos **duplica** productos (pasó el 4 y el 14 sep). Comparar handles antes.

## Estructura

```
src/
  app.ts · config/env.ts (lectura perezosa: falla el endpoint, no el arranque)
  middleware/autenticacion.ts   x-api-key
  routes/shopifyWebhooks.ts     HMAC sobre el cuerpo crudo
  services/   CtClient · CtSimulado · ctFactory · ShopifyClient · InventorySyncService · OrderService · bitacora
deploy/proxy/  Caddyfile + instalar.sh del proxy con IP fija
  entities/ · jobs/confirmScheduler · jobs/inventoryScheduler · migrations/ · scripts/ · tests/
```

## Pendientes

- Proxy de IP fija: crear el Droplet, correr `instalar.sh`, poner `CT_BASE_URL` y `CT_PROXY_KEY` en Railway y mandar la IP a CT (ecom@ctin.com.mx).
- Railway: pasar a plan Hobby antes de que acabe la prueba. El push a `main` no siempre dispara el deploy: verificar y usar "Deploy latest commit".
- Dirección de envío: Shopify no tiene colonia; hoy sale de `company`. `tipoPago` y `cfdi` provisionales. Acordar con CT.
- Mapeos: 88 candidatos en `data/candidatos-ct.csv` sin clave de CT (48 sin SKU, ya no importa). Hace falta el catálogo de CT.
- Producción puede ir en `CT_MODO=real` sin credenciales: toda orden queda `blocked` (`ct_sin_conexion`) y se reintenta al llegar.
- Paso 6 hecho (17 sep): `npm run simular:ct` pasa los cuatro escenarios. No cubre las escrituras a Shopify.
- Paso 7: CT real. Hace falta que un representante de CT dé `email`, `cliente` y `rfc` para `/cliente/token`.
