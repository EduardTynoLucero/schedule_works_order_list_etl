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
    password: must("DB_PASS"),
    database: must("DB_NAME"),
    port: Number(process.env.DB_PORT ?? "3306"),
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
      pageTo: toNum(process.env.WORKS_PAGE_TO, 999999),
      pageSizeStop: toNum(process.env.WORKS_PAGE_SIZE_STOP, 50),
      fetchDetailsWhenMissingPatient: toBool(process.env.WORKS_FETCH_DETAILS_WHEN_MISSING_PATIENT, false),
      detailConcurrency: toNum(process.env.WORKS_DETAIL_CONCURRENCY, 2),
      backfillMissingPatients: toBool(process.env.WORKS_BACKFILL_MISSING_PATIENTS, false),
      backfillMissingPatientsLimit: toNum(process.env.WORKS_BACKFILL_MISSING_PATIENTS_LIMIT, 500),
    },
  },
};
