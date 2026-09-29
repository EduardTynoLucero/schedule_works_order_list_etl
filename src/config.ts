import dotenv from "dotenv";
dotenv.config();

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function toBool(v: any, def = false) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

// Acepta DB_PASS o DB_PASSWORD y permite contraseña vacía (MySQL local sin password).
function dbPassword(): string {
  const v = process.env.DB_PASS ?? process.env.DB_PASSWORD;
  if (v === undefined) throw new Error("Missing env var: DB_PASS (o DB_PASSWORD)");
  return v;
}

function toNum(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// [SPLIT] Este repo solo corre el listado de works. DETAILS_ONLY vive en schedule_works_order_details_etl.
type EtlMode = "AUTO" | "UPDATED_SINCE" | "PAGING_ONLY";

function toEtlMode(v: any): EtlMode {
  const s = String(v ?? "AUTO").trim().toUpperCase();
  if (!s || s === "AUTO") return "AUTO";
  if (s === "UPDATED_SINCE" || s === "INCREMENTAL" || s === "TODAY") return "UPDATED_SINCE";
  if (s === "PAGING_ONLY" || s === "FULL" || s === "SNAPSHOT") return "PAGING_ONLY";
  if (s === "DETAILS_ONLY" || s === "DETAILS" || s === "WORK_DETAILS") {
    throw new Error(
      `ETL_MODE=${s} no aplica en este repo (listado de works). ` +
        `El detalle de ordenes corre en schedule_works_order_details_etl.`
    );
  }

  throw new Error(`Invalid ETL_MODE=${s}. Use AUTO, UPDATED_SINCE or PAGING_ONLY.`);
}

// Paginacion automatica: ya no hay pagina final ni tamaño de pagina quemados.
for (const legacy of ["WORKS_PAGE_TO", "WORKS_PAGE_SIZE_STOP"]) {
  if (process.env[legacy]) {
    console.warn(`[WARN] ${legacy} ya no se usa: el ETL detecta solo cuantas paginas devuelve la API.`);
  }
}

const etlMode = toEtlMode(process.env.ETL_MODE);
const forcePagingOnly = etlMode === "PAGING_ONLY";
const forceUpdatedSince = etlMode === "UPDATED_SINCE";


export const config = {
  api: {
    baseUrl: must("API_BASE_URL"),
    token: must("API_TOKEN"),
    authHeader: process.env.API_AUTH_HEADER ?? "Authorization",
    authPrefix: process.env.API_AUTH_PREFIX ?? "Bearer",
  },
  db: {
    host: must("DB_HOST"),
    user: must("DB_USER"),
    password: dbPassword(),
    database: must("DB_NAME"),
    port: Number(process.env.DB_PORT ?? "3306"),
    // [RAM] limites del pool (ver src/db.ts)
    poolLimit: Math.max(1, toNum(process.env.DB_POOL_LIMIT, 5)),
    poolMaxIdle: Math.max(0, toNum(process.env.DB_POOL_MAX_IDLE, 2)),
    maxPreparedStatements: Math.max(1, toNum(process.env.DB_MAX_PREPARED_STATEMENTS, 50)),
  },
  tz: process.env.TZ ?? "America/Guatemala",
  cronExpr: process.env.CRON_EXPR ?? "*/3 * * * *",

  etl: {
    mode: etlMode,
    runOnce: toBool(process.env.ETL_RUN_ONCE, false),
    forceUpdatedSince: (process.env.FORCE_UPDATED_SINCE ?? "").trim() || null,
  },

  deletes: {
    worksSoftDelete: toBool(process.env.WORKS_ENABLE_SOFT_DELETE, false),
  },

  paging: {
    works: {
      pagingOnly: forcePagingOnly ? true : forceUpdatedSince ? false : toBool(process.env.WORKS_PAGING_ONLY, false),
      pageFrom: toNum(process.env.WORKS_PAGE_FROM, 0),
      fetchDetailsWhenMissingPatient: toBool(process.env.WORKS_FETCH_DETAILS_WHEN_MISSING_PATIENT, false),
      detailConcurrency: toNum(process.env.WORKS_DETAIL_CONCURRENCY, 2),
      // [ENVIO] consultar SIEMPRE /works/{id}: status, status_name y fecha de envio (delivery_note_date) del detalle
      fetchDetailForDelivery: toBool(process.env.WORKS_FETCH_DETAIL_FOR_DELIVERY, true),
      // 0 (default) = consultar SIEMPRE el detalle de todas las ordenes; 1 = solo nuevas, cambiadas o abiertas
      detailOnlyChanged: toBool(process.env.WORKS_DETAIL_ONLY_CHANGED, false),
      // ordenes abiertas (sin fecha de envio): volver a consultar su detalle como maximo cada N minutos
      openRecheckMinutes: Math.max(0, toNum(process.env.WORKS_OPEN_RECHECK_MINUTES, 30)),
      // paginas del listado pedidas a la vez
      pageConcurrency: Math.max(1, toNum(process.env.WORKS_PAGE_CONCURRENCY, 8)),
      // [VELOCIDAD] detalles que se juntan antes de guardarlos en external_work_details (una transaccion)
      detailSaveBatch: Math.max(1, toNum(process.env.WORKS_DETAIL_SAVE_BATCH, 500)),
      // pausa entre paginas (antes 150 ms fijos en PAGING_ONLY)
      pageDelayMs: Math.max(0, toNum(process.env.WORKS_PAGE_DELAY_MS, 0)),
      // PAGING_ONLY: aplicar a works cada N paginas (0 = solo al final)
      partialUpsertEveryPages: Math.max(0, toNum(process.env.WORKS_PARTIAL_UPSERT_EVERY_PAGES, 0)),
      // backfill de pacientes: no reintentar la misma orden antes de N horas
      backfillRetryHours: Math.max(0, toNum(process.env.WORKS_BACKFILL_RETRY_HOURS, 6)),
      backfillMissingPatients: toBool(process.env.WORKS_BACKFILL_MISSING_PATIENTS, false),
      backfillMissingPatientsLimit: toNum(process.env.WORKS_BACKFILL_MISSING_PATIENTS_LIMIT, 500),
      // WORKS_FIND_EXTERNAL_ID: external_id a buscar (o varios separados por coma).
      // Al terminar la corrida se imprime en que pagina de la API aparecio.
      findExternalIds: String(process.env.WORKS_FIND_EXTERNAL_ID ?? "")
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    },
  },
};
