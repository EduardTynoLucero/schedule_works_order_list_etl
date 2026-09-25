import { logger } from "./common/logger.js";
import { createHash } from "node:crypto";
import { exec } from "../db.js";
import { paginate } from "./common/pagination.js";
import { bulkInsert } from "./common/bulkInsert.js";
import { withTx } from "./common/tx.js";
import { SQL } from "./common/sql.js";
import { config } from "../config.js";
import { detectPageBase } from "./common/pageBase.js";
import { fetchWorkDetail, fetchWorksPage } from "./api/worksApiClient.js";
import type { WorkItem } from "../types/worksApi.js";
// [SPLIT] validaciones de clinicas/doctores (ahora los carga schedule_clinics_doctors_etl)
import {
  ensureWorkDependenciesReady,
  logMissingWorkDependencies,
  relinkWorkReferences,
} from "./worksDependencies.js";

function normalizePatientKeyPart(value?: string | number | null) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function patientName(w: WorkItem) {
  return w.patient?.name ?? w.patient_name ?? null;
}

function clinicExternalId(w: WorkItem) {
  return w.clinic_id ?? w.clinic?.id ?? null;
}

function doctorExternalId(w: WorkItem) {
  return w.doctor_id ?? w.doctor?.id ?? null;
}

function patientAge(w: WorkItem) {
  const rawAge = w.patient?.age?.trim();
  if (!rawAge) return null;

  const match = rawAge.match(/\d+/);
  return match ? Number(match[0]) : null;
}

function buildPatientKey(w: WorkItem) {
  const name = normalizePatientKeyPart(patientName(w));
  if (!name) return null;

  const rawKey = [
    normalizePatientKeyPart(clinicExternalId(w)),
    name,
    normalizePatientKeyPart(w.patient?.sex),
    normalizePatientKeyPart(patientAge(w)),
  ].join("|");

  return createHash("sha256").update(rawKey).digest("hex");
}

function needsWorkDetail(w: WorkItem) {
  if (!w.id) return false;

  return !patientName(w)?.trim();
}

function mergeWorkDetail(w: WorkItem, detail: WorkItem | null) {
  if (!detail) return w;

  return {
    ...w,
    ...detail,
    id: detail.id ?? w.id,
    code: detail.code ?? w.code,
    box: detail.box ?? w.box,
    created_at: detail.created_at ?? w.created_at,
    accept_date: detail.accept_date ?? w.accept_date,
    estimated_delivery: detail.estimated_delivery ?? w.estimated_delivery,
    finish_date: detail.finish_date ?? w.finish_date,
    status: detail.status ?? w.status,
    status_name: detail.status_name ?? w.status_name,
    clinic_id: detail.clinic_id ?? w.clinic_id,
    doctor_id: detail.doctor_id ?? w.doctor_id,
    clinic: detail.clinic ?? w.clinic,
    doctor: detail.doctor ?? w.doctor,
    patient_name: detail.patient_name ?? w.patient_name,
    patient: detail.patient ?? w.patient,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}

async function enrichWorksWithDetail(items: WorkItem[], page: number) {
  if (!config.paging.works.fetchDetailsWhenMissingPatient) return items;

  const detailsNeeded = items.filter(needsWorkDetail).length;
  if (!detailsNeeded) return items;

  let fetched = 0;
  let failed = 0;
  const concurrency = Math.max(1, config.paging.works.detailConcurrency);

  const enrichedItems = await mapWithConcurrency(items, concurrency, async (w) => {
    if (!needsWorkDetail(w)) return w;

    try {
      const detail = await fetchWorkDetail(w.id);
      fetched += 1;
      return mergeWorkDetail(w, detail);
    } catch (err: any) {
      failed += 1;
      logger.warn(
        `Works ETL: no pude cargar detalle work_id=${w.id} ` +
          `status=${err?.response?.status ?? err?.code ?? err?.message ?? "unknown"}`
      );
      return w;
    }
  });

  logger.info(
    `Works ETL: page=${page} detalles consultados=${fetched}/${detailsNeeded}` +
      (failed ? ` failed=${failed}` : "")
  );

  return enrichedItems;
}

async function stageWorks(works: WorkItem[]) {
  if (!works.length) return;

  const rows = works.map((w) => ([
    w.id ?? null,
    w.code ?? null,
    w.box ?? null,
    w.created_at ?? null,
    w.accept_date ?? null,
    w.estimated_delivery ?? null,
    w.finish_date ?? null,
    w.status ?? null,
    w.status_name ?? null,

    // clinic
    clinicExternalId(w),
    clinicExternalId(w),

    // doctor
    null, // doctor_id local (si luego lo resuelves con JOIN)
    doctorExternalId(w),

    // patient
    null
  ]));

  await bulkInsert(
    "stg_works",
    [
      "external_id","code","box","created_at_api","accepted_date","estimated_delivery","finish_date",
      "status","status_name",
      "clinic_id","clinic_external_id",
      "doctor_id","doctor_external_id",
      "patient_id"
    ],
    rows,
    1000
  );

  const patientRows = works
    .map((w) => {
      const patientKey = buildPatientKey(w);
      const name = patientName(w);
      if (!patientKey || !name?.trim()) return null;

      return [
        patientKey,
        w.id ?? null,
        clinicExternalId(w),
        name,
        patientAge(w),
        w.patient?.sex ?? null,
        w.patient?.sex_name ?? null,
      ];
    })
    .filter((row): row is any[] => row !== null);

  if (patientRows.length) {
    await bulkInsert(
      "stg_patients",
      [
        "patient_key",
        "work_external_id",
        "clinic_external_id",
        "name",
        "age",
        "sex",
        "sex_name",
      ],
      patientRows,
      1000
    );
  }
}

async function upsertWorksAndPatientsFromStg(context: string) {
  await withTx(async (conn) => {
    await conn.execute(SQL.upsertPatientsFromStg);
    await conn.execute(SQL.upsertWorksFromStg);
  });

  logger.info(`Works ETL: upsert parcial aplicado (${context})`);
}

async function backfillMissingPatientsFromDetails() {
  if (!config.paging.works.backfillMissingPatients) return;

  const limit = Math.max(0, config.paging.works.backfillMissingPatientsLimit);
  if (!limit) return;
  const limitSql = Math.trunc(limit);

  const missingWorks = await exec<Array<{ external_id: number }>>(
    `
      SELECT external_id
      FROM works
      WHERE external_id IS NOT NULL
        AND patient_id IS NULL
        AND is_deleted = 0
      ORDER BY created_at_api DESC, work_id DESC
      LIMIT ${limitSql}
    `
  );

  if (!missingWorks.length) return;

  logger.info(
    `Works ETL: backfill pacientes faltantes start total=${missingWorks.length} concurrency=${Math.max(
      1,
      config.paging.works.detailConcurrency
    )}`
  );

  let fetched = 0;
  let failed = 0;
  let processed = 0;
  const works = await mapWithConcurrency(
    missingWorks,
    Math.max(1, config.paging.works.detailConcurrency),
    async ({ external_id }) => {
      try {
        const detail = await fetchWorkDetail(external_id);
        if (detail && patientName(detail)?.trim()) fetched += 1;
        return detail;
      } catch (err: any) {
        failed += 1;
        logger.warn(
          `Works ETL: no pude cargar detalle faltante work_id=${external_id} ` +
            `status=${err?.response?.status ?? err?.code ?? err?.message ?? "unknown"}`
        );
        return null;
      } finally {
        processed += 1;
        if (processed % 50 === 0 || processed === missingWorks.length) {
          logger.info(
            `Works ETL: backfill pacientes faltantes progreso=${processed}/${missingWorks.length} fetched=${fetched} failed=${failed}`
          );
        }
      }
    }
  );

  const worksWithPatient = works.filter((w): w is WorkItem => Boolean(w && patientName(w)?.trim()));
  if (!worksWithPatient.length) {
    logger.info(
      `Works ETL: backfill pacientes faltantes sin registros aplicables ` +
        `consultados=${missingWorks.length} failed=${failed}`
    );
    return;
  }

  await stageWorks(worksWithPatient);
  await upsertWorksAndPatientsFromStg(`missing-patients limit=${limit}`);

  logger.info(
    `Works ETL: backfill pacientes faltantes aplicados=${worksWithPatient.length} ` +
      `consultados=${missingWorks.length} fetched=${fetched} failed=${failed}`
  );
}

export async function worksEtl(updatedSince: string) {
  logger.info("Works ETL (STG): start");

  // [SPLIT] primero validar que clients/doctors ya existan antes de tocar works
  if (!(await ensureWorkDependenciesReady())) return;

  await exec(SQL.truncateStgWorks);
  await exec(SQL.truncateStgPatients);

  const pagingOnly = config.paging.works.pagingOnly;
  const sinceParam = pagingOnly ? null : updatedSince;

  // base 0/1 solo importa en snapshot
  let base = 0;
  if (pagingOnly) base = await detectPageBase((p) => fetchWorksPage(p, null));

  const pageStart = pagingOnly ? (config.paging.works.pageFrom + base) : 0;
  const pageMax   = pagingOnly ? (config.paging.works.pageTo + base) : 999999;

  logger.info(
    `Works ETL: mode=${pagingOnly ? "PAGING_ONLY" : "UPDATED_SINCE"} base=${base} pages=${pageStart}..${pageMax} ` +
    `softDeleteGlobal=${pagingOnly && config.deletes.worksSoftDelete}`
  );

  await backfillMissingPatientsFromDetails();

  await paginate<WorkItem>(
    async (page) => fetchWorksPage(page, sinceParam),
    async (items, page) => {
      logger.info(`Works ETL: page=${page} items=${items.length}`);
      if (!items.length) return;

      const works = await enrichWorksWithDetail(items, page);
      await stageWorks(works);

      if (pagingOnly && (page === pageStart || (page - pageStart + 1) % 100 === 0)) {
        await upsertWorksAndPatientsFromStg(`page=${page}`);
      }
    },
    {
      pageStart,
      pageMax,
      pageSizeStop: config.paging.works.pageSizeStop,
      forceRange: pagingOnly, // snapshot: NO se corta por items<50
      delayMs: pagingOnly ? 150 : 0,
    }
  );

  const [{ c: stgCount }] = await exec<Array<{ c: number }>>("SELECT COUNT(*) c FROM stg_works");
  logger.info(`Works ETL: stg_works=${stgCount}`);

  // [SPLIT] validar clinica/doctor de cada work en STG antes del upsert
  await logMissingWorkDependencies("final");

  await withTx(async (conn) => {
    await conn.execute(SQL.upsertPatientsFromStg);
    await conn.execute(SQL.upsertWorksFromStg);

    // ✅ SOLO snapshot
    if (pagingOnly && config.deletes.worksSoftDelete) {
      // Candado para no matar data si STG quedó incompleta
      if (stgCount < 80000) {
        logger.warn(`Works ETL: STG incompleta (${stgCount}). NO hago soft delete global.`);
      } else {
        await conn.execute(SQL.softDeleteWorksMissingFromStg);
      }
    }


  });

  // [SPLIT] completar doctor_id/clinic_id de works que llegaron antes que su doctor/clinica
  await relinkWorkReferences();

  logger.info("Works ETL (STG): done");
}
