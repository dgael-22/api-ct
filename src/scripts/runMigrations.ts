/**
 * src/scripts/runMigrations.ts
 * ============================
 * Aplica las migraciones pendientes y sale. Es lo que corre Railway antes de
 * arrancar el servidor (`npm run migration:run && npm start`).
 *
 * Es idempotente: TypeORM lleva su tabla de migraciones aplicadas, así que
 * volver a desplegar no repite nada.
 */
import { AppDataSource, esPostgres, inicializarBd } from "../data-source";
import { env } from "../config/env";

async function principal(): Promise<void> {
  console.log(
    `Base de datos: ${esPostgres() ? "PostgreSQL" : "SQLite"}` +
      (esPostgres() && env.db.ssl ? " (con SSL)" : "")
  );

  await inicializarBd();

  const pendientes = await AppDataSource.showMigrations();
  console.log(
    pendientes
      ? "Quedan migraciones pendientes."
      : "Esquema al día: no hay migraciones pendientes."
  );

  await AppDataSource.destroy();
}

principal()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fallaron las migraciones:", (e as Error).message);
    process.exit(1);
  });
