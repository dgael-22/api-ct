/**
 * src/entities/tipos.ts
 * =====================
 * Tipos de columna que NO se llaman igual en los dos motores.
 *
 * SQLite usa `datetime`; PostgreSQL usa `timestamp`, y no acepta el otro.
 * TypeORM valida los tipos de las entidades contra el driver al inicializar,
 * así que poner uno fijo hace que la app truene al arrancar con el otro motor.
 *
 * Se resuelve una sola vez, al cargar el módulo, mirando DATABASE_URL.
 */
import { ColumnType } from "typeorm";
import { env } from "../config/env";

const esPostgres = env.db.url.startsWith("postgres");

/** `timestamp` en PostgreSQL, `datetime` en SQLite. */
export const TIPO_FECHA: ColumnType = esPostgres ? "timestamp" : "datetime";
