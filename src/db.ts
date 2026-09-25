import mysql from "mysql2/promise";
import { config } from "./config.js";

// [RAM] Pool acotado para no saturar MySQL ni la RAM:
// - connectionLimit: el ETL trabaja en secuencia, 1-2 conexiones alcanzan (default 5).
// - maxIdle + idleTimeout: las conexiones ociosas de mas se cierran a los 60s.
// - maxPreparedStatements: mysql2 guarda en memoria (y MySQL en el servidor) cada prepared
//   statement distinto; por defecto hasta 16000 POR CONEXION. Se limita a un numero chico.
export const pool = mysql.createPool({
  host: config.db.host,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  port: config.db.port,
  waitForConnections: true,
  connectionLimit: config.db.poolLimit,
  maxIdle: config.db.poolMaxIdle,
  idleTimeout: 60000,
  maxPreparedStatements: config.db.maxPreparedStatements,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  // opcional: timeouts
  connectTimeout: 30000
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableDbError(err: any) {
  const code = err?.code;
  return (
    code === "ECONNRESET" ||
    code === "PROTOCOL_CONNECTION_LOST" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR"
  );
}

async function withDbRetry<T>(run: () => Promise<T>): Promise<T> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await run();
    } catch (err: any) {
      if (isRetryableDbError(err) && attempt < maxRetries) {
        // backoff: 0.5s, 1s, 2s
        await sleep(500 * Math.pow(2, attempt - 1));
        continue;
      }
      throw err;
    }
  }

  // nunca debería llegar aquí
  throw new Error("DB exec failed after retries");
}

/** SQL fijo (siempre el mismo texto): prepared statement, se reutiliza del cache. */
export async function exec<T = any>(sql: string, params: any[] = []): Promise<T> {
  return withDbRetry(async () => {
    const [rows] = await pool.execute(sql, params);
    return rows as T;
  });
}

/**
 * [RAM] SQL armado dinamicamente (INSERT de N filas, IN (...) de N valores).
 * Usa el protocolo de texto (query): los valores se escapan igual, pero NO se crea un
 * prepared statement nuevo por cada tamaño de lote (eso era lo que llenaba la RAM).
 */
export async function execQuery<T = any>(sql: string, params: any[] = []): Promise<T> {
  return withDbRetry(async () => {
    const [rows] = await pool.query(sql, params);
    return rows as T;
  });
}

let poolClosed = false;

/** Cierra el pool (al terminar ETL_RUN_ONCE o al recibir SIGINT/SIGTERM). */
export async function closePool() {
  if (poolClosed) return;
  poolClosed = true;
  try {
    await pool.end();
  } catch {
    // ya estaba cerrado
  }
}
