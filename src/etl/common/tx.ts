import { pool } from "../../db.js";
import { logger } from "./logger.js";

// [SPLIT] Ahora hay 3 ETLs corriendo en paralelo contra la misma BD
// (clinicas/doctores, listado de works y detalle de works). Entre procesos pueden
// aparecer deadlocks o lock wait timeout. En ese caso se reintenta la transaccion
// completa: todas las transacciones del ETL son idempotentes (upserts / soft deletes /
// delete+insert de hijos), asi que repetirlas no duplica ni pierde datos.
const RETRYABLE_TX_ERRORS = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);
const MAX_TX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withTx<T>(fn: (conn: any) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const res = await fn(conn);
      await conn.commit();
      return res;
    } catch (e: any) {
      await conn.rollback();

      if (RETRYABLE_TX_ERRORS.has(e?.code) && attempt < MAX_TX_ATTEMPTS) {
        const waitMs = 1_000 * attempt;
        logger.warn(`TX retry ${attempt}/${MAX_TX_ATTEMPTS - 1} code=${e.code} wait=${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      throw e;
    } finally {
      conn.release();
    }
  }
}
