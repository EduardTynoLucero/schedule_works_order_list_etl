import mysql from "mysql2/promise";
import { config } from "./config.js";

export const pool = mysql.createPool({
  host: config.db.host,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  port: config.db.port,
  waitForConnections: true,
  connectionLimit: 10,
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

export async function exec<T = any>(sql: string, params: any[] = []): Promise<T> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const [rows] = await pool.execute(sql, params);
      return rows as T;
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
