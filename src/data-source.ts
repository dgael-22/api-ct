/**
 * src/data-source.ts
 * ==================
 * Conexión a la base de datos. TypeORM no es la base: es la librería que
 * permite definir y consultar las dos tablas desde TypeScript (sección 5 del ETS).
 *
 * Una sola variable decide el motor:
 *
 *   DATABASE_URL=sqlite:./data/schu-ct.sqlite     desarrollo local
 *   DATABASE_URL=postgresql://...                 Railway / producción
 *
 * Las entidades y los servicios no cambian entre uno y otro.
 *
 * El esquema se crea SIEMPRE con migraciones, nunca con `synchronize`. En
 * producción `synchronize` puede borrar o alterar columnas sin avisar, y aquí
 * hay órdenes reales.
 */
import "reflect-metadata";
import { DataSource } from "typeorm";
import { env } from "./config/env";
import { Evento } from "./entities/Evento";
import { OrderMapping } from "./entities/OrderMapping";
import { ProductMapping } from "./entities/ProductMapping";
import { CrearTablasIniciales1757000000000 } from "./migrations/1757000000000-CrearTablasIniciales";
import { GuardarOrdenRecibida1758100000000 } from "./migrations/1758100000000-GuardarOrdenRecibida";
import { CrearBitacora1758200000000 } from "./migrations/1758200000000-CrearBitacora";

const ENTIDADES = [ProductMapping, OrderMapping, Evento];
const MIGRACIONES = [
  CrearTablasIniciales1757000000000, GuardarOrdenRecibida1758100000000, CrearBitacora1758200000000,
];

/** ¿La URL apunta a PostgreSQL? */
export function esPostgres(url: string = env.db.url): boolean {
  return url.startsWith("postgres");
}

function construirDataSource(): DataSource {
  const url = env.db.url;

  if (esPostgres(url)) {
    return new DataSource({
      type: "postgres",
      url,
      entities: ENTIDADES,
      migrations: MIGRACIONES,
      synchronize: false,
      logging: false,
      // Railway: por la red interna (…​.railway.internal) NO se usa SSL; por la
      // URL pública sí. Se decide con DB_SSL para no adivinar.
      ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
    });
  }

  // "sqlite:./data/schu-ct.sqlite" -> "./data/schu-ct.sqlite"
  const archivo = url.replace(/^sqlite:(\/\/)?/, "") || "./data/schu-ct.sqlite";
  return new DataSource({
    type: "better-sqlite3",
    database: archivo,
    entities: ENTIDADES,
    migrations: MIGRACIONES,
    synchronize: false,
    logging: false,
  });
}

export const AppDataSource = construirDataSource();

/**
 * Abre la conexión y aplica las migraciones pendientes. Es idempotente: TypeORM
 * lleva su propia tabla de migraciones aplicadas, así que arrancar dos veces no
 * duplica nada.
 */
export async function inicializarBd(): Promise<DataSource> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
    const aplicadas = await AppDataSource.runMigrations();
    if (aplicadas.length) {
      console.log(
        `Migraciones aplicadas: ${aplicadas.map((m) => m.name).join(", ")}`
      );
    }
  }
  return AppDataSource;
}

export function repositorios() {
  return {
    productos: AppDataSource.getRepository(ProductMapping),
    ordenes: AppDataSource.getRepository(OrderMapping),
    eventos: AppDataSource.getRepository(Evento),
  };
}
