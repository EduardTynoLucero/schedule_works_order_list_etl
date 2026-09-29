import { logger } from "./common/logger.js";
import { createHash } from "node:crypto";
import { exec, execQuery } from "../db.js";
import { cleanText, persistDetails, toMysqlDate, uniqueNumbers, type DetailResult } from "./detailStore.js";
import { paginate } from "./common/pagination.js";
import { bulkInsert } from "./common/bulkInsert.js";
import { withTx } from "./common/tx.js";
import { SQL } from "./common/sql.js";
import { config } from "../config.js";
import { detectPageBase } from "./common/pageBase.js";
import { fetchWorkDetail, fetchWorksPage, fetchWorksPageWithMeta } from "./api/worksApiClient.js";
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

/* =====================================================================
 * [ENVIO] Siempre se consulta el detalle (/works/{id}) de cada orden del listado
 * ---------------------------------------------------------------------
 * - works (padre): status y status_name del detalle, y estimated_delivery = delivery_note_date
 *   (fecha de envio; NULL si la orden aun no se envia). Las demas fechas son las del listado.
 *   Paciente, clinica y doctor del detalle solo si el listado no los trae.
 * - external_work_details (hijo): se guarda el detalle completo (tambien tareas, productos, tags y
 *   lotes) de las ordenes que ya existen en works. Las ordenes nuevas las crea el ETL de detalle.
 * - Si la consulta al detalle falla, la orden conserva el status y la fecha que ya tenia en works
 *   (no se usan los del listado); si es nueva, status del listado y fecha NULL.
 * - WORKS_DETAIL_CACHE_MINUTES > 0: no repite la consulta de la misma orden durante esos minutos si
 *   su status en el listado no cambio. 0 = siempre consulta.
 * ===================================================================== */

type WorkState = {
  workId: number;
  status: string | null;
  statusName: string | null;
  estimatedDelivery: string | null;
};

type DetailValues = {
  status: string | null;
  statusName: string | null;
  deliveryNoteDate: string | null; // YYYY-MM-DD
};

type CachedDetail = DetailValues & { at: number; listStatus: string | null };

const detailCache = new Map<number, CachedDetail>();

function detailCacheMs() {
  return Math.max(0, config.paging.works.detailCacheMinutes) * 60_000;
}

function pruneDetailCache() {
  const ttl = detailCacheMs();
  if (!ttl) {
    detailCache.clear();
    return;
  }
  const minAt = Date.now() - ttl;
  for (const [id, cached] of detailCache) {
    if (cached.at < minAt) detailCache.delete(id);
  }
}

/** Lo que ya hay en works para estas ordenes (work_id para guardar el detalle y valores actuales). */
async function loadWorksState(ids: number[]) {
  const state = new Map<number, WorkState>();
  if (!ids.length) return state;

  const rows = await execQuery<
    Array<{
      work_id: number;
      external_id: number;
      status: string | null;
      status_name: string | null;
      estimated_delivery: string | null;
    }>
  >(
    `
      SELECT work_id, external_id, status, status_name,
             DATE_FORMAT(estimated_delivery, '%Y-%m-%d %H:%i:%s') AS estimated_delivery
      FROM works
      WHERE external_id IN (?)
    `,
    [ids]
  );

  for (const row of rows) {
    state.set(Number(row.external_id), {
      workId: Number(row.work_id),
      status: cleanText(row.status),
      statusName: cleanText(row.status_name),
      estimatedDelivery: cleanText(row.estimated_delivery),
    });
  }
  return state;
}

function detailValuesOf(detail: WorkItem): DetailValues {
  return {
    status: cleanText(detail.status),
    statusName: cleanText(detail.status_name),
    deliveryNoteDate: toMysqlDate(detail.delivery_note_date),
  };
}

/** Orden del listado con status, status_name y fecha de envio del detalle. */
function withDetailValues(w: WorkItem, values: DetailValues, detail?: WorkItem | null): WorkItem {
  const merged: WorkItem = {
    ...w,
    status: values.status ?? w.status,
    status_name: values.statusName ?? w.status_name,
    estimated_delivery: values.deliveryNoteDate,
    delivery_note_date: values.deliveryNoteDate,
  };

  if (detail) {
    if (!patientName(w)?.trim()) {
      merged.patient = detail.patient ?? w.patient;
      merged.patient_name = detail.patient_name ?? w.patient_name;
    }
    if (clinicExternalId(w) === null) {
      merged.clinic_id = detail.clinic_id ?? w.clinic_id;
      merged.clinic = detail.clinic ?? w.clinic;
    }
    if (doctorExternalId(w) === null) {
      merged.doctor_id = detail.doctor_id ?? w.doctor_id;
      merged.doctor = detail.doctor ?? w.doctor;
    }
  }

  return merged;
}

/** Si el detalle fallo: conservar lo que ya hay en works (el status y la fecha del listado no sirven). */
function withCurrentValues(w: WorkItem, current?: WorkState): WorkItem {
  if (!current) return { ...w, estimated_delivery: null };
  return {
    ...w,
    status: current.status ?? w.status,
    status_name: current.statusName ?? w.status_name,
    estimated_delivery: current.estimatedDelivery,
  };
}

async function enrichWorksWithDetail(items: WorkItem[], page: number) {
  const always = config.paging.works.fetchDetailForDelivery;
  const byPatient = config.paging.works.fetchDetailsWhenMissingPatient;
  if (!always && !byPatient) return items;

  const startedAt = Date.now();
  const ids = uniqueNumbers(items.map((w) => (Number.isFinite(Number(w.id)) ? Number(w.id) : null)));
  const state = await loadWorksState(ids);
  const ttlMs = detailCacheMs();

  let fromCache = 0;
  type Plan = { w: WorkItem; action: "keep" | "cache" | "fetch"; cached?: CachedDetail };
  const plans: Plan[] = items.map((w): Plan => {
    if (!w.id) return { w, action: "keep" };
    const needPatient = byPatient && needsWorkDetail(w);
    if (!always) return { w, action: needPatient ? "fetch" : "keep" };

    const cached = detailCache.get(Number(w.id));
    if (
      !needPatient &&
      cached &&
      ttlMs &&
      cached.listStatus === cleanText(w.status) &&
      startedAt - cached.at < ttlMs
    ) {
      fromCache += 1;
      return { w, action: "cache", cached };
    }
    return { w, action: "fetch" };
  });

  const toFetch = plans.filter((p) => p.action === "fetch").length;
  if (!toFetch && !fromCache) return items;

  let fetched = 0;
  let failed = 0;
  const toSave: DetailResult[] = [];
  const concurrency = Math.max(1, config.paging.works.detailConcurrency);

  const enrichedItems = await mapWithConcurrency(plans, concurrency, async (p) => {
    if (p.action === "keep") return p.w;
    if (p.action === "cache") return withDetailValues(p.w, p.cached!);

    const id = Number(p.w.id);
    try {
      const detail = await fetchWorkDetail(p.w.id);
      if (!detail?.id) throw new Error("detalle vacio");
      fetched += 1;

      const values = detailValuesOf(detail);
      if (ttlMs) detailCache.set(id, { ...values, at: Date.now(), listStatus: cleanText(p.w.status) });

      const current = state.get(id);
      if (current) toSave.push({ ref: { work_id: current.workId, external_id: id }, detail });

      return withDetailValues(p.w, values, detail);
    } catch (err: any) {
      failed += 1;
      logger.warn(
        `Works ETL: no pude cargar detalle work_id=${p.w.id} ` +
          `status=${err?.response?.status ?? err?.code ?? err?.message ?? "unknown"}`
      );
      return always ? withCurrentValues(p.w, state.get(id)) : p.w;
    }
  });

  // hijo: detalle completo (external_work_details + tareas, productos, tags, lotes)
  if (toSave.length) await persistDetails(toSave);

  logger.info(
    `Works ETL: page=${page} detalles consultados=${fetched}/${toFetch} ` +
      `guardados en external_work_details=${toSave.length}` +
      (fromCache ? ` desde cache=${fromCache}` : "") +
      (failed ? ` failed=${failed}` : "") +
      ` (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
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

  // [ENVIO] en el backfill los registros son detalles: se guarda el detalle completo (hijo) y en works
  // estimated_delivery = delivery_note_date
  const backfillState = await loadWorksState(uniqueNumbers(worksWithPatient.map((w) => Number(w.id))));
  const backfillSave: DetailResult[] = [];
  for (const w of worksWithPatient) {
    const current = backfillState.get(Number(w.id));
    if (current) backfillSave.push({ ref: { work_id: current.workId, external_id: Number(w.id) }, detail: w });
  }
  if (backfillSave.length) await persistDetails(backfillSave);
  await stageWorks(
    worksWithPatient.map((w) => ({ ...w, estimated_delivery: toMysqlDate(w.delivery_note_date) }))
  );
  await upsertWorksAndPatientsFromStg(`missing-patients limit=${limit}`);

  logger.info(
    `Works ETL: backfill pacientes faltantes aplicados=${worksWithPatient.length} ` +
      `consultados=${missingWorks.length} fetched=${fetched} failed=${failed}`
  );
}

export async function worksEtl(updatedSince: string) {
  logger.info("Works ETL (STG): start");
  pruneDetailCache();

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
  // sin pagina final quemada: la API indica cuando ya no hay mas

  logger.info(
    `Works ETL: mode=${pagingOnly ? "PAGING_ONLY" : "UPDATED_SINCE"} base=${base} pages=${pageStart}..auto ` +
    `softDeleteGlobal=${pagingOnly && config.deletes.worksSoftDelete}`
  );

  await backfillMissingPatientsFromDetails();

  // busqueda de WORKS_FIND_EXTERNAL_ID: external_id -> paginas donde aparecio
  const findIds = new Set(config.paging.works.findExternalIds);
  const foundIn = new Map<number, Array<{ page: number; code: string | null }>>();
  if (findIds.size) logger.info(`Works ETL: buscando external_id=${[...findIds].join(",")}`);

  const pages = await paginate<WorkItem>(
    async (page) => fetchWorksPageWithMeta(page, sinceParam),
    async (items, page) => {
      logger.info(`Works ETL: page=${page} items=${items.length}`);
      if (!items.length) return;

      // ordenes procesadas en esta pagina: external_id (id de la API) / code
      logger.info(
        `Works ETL: page=${page} ordenes (external_id/code): ` +
          items.map((w) => `${w.id}/${w.code ?? "-"}`).join(", ")
      );

      if (findIds.size) {
        for (const w of items) {
          const id = Number(w.id);
          if (!findIds.has(id)) continue;
          const hits = foundIn.get(id) ?? [];
          hits.push({ page, code: w.code ?? null });
          foundIn.set(id, hits);
        }
      }

      const works = await enrichWorksWithDetail(items, page);
      await stageWorks(works);

      if (pagingOnly && (page === pageStart || (page - pageStart + 1) % 100 === 0)) {
        await upsertWorksAndPatientsFromStg(`page=${page}`);
      }
    },
    {
      pageStart,
      label: "Works ETL",
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
      } else if (!pages.complete) {
        logger.warn(`Works ETL: paginacion incompleta (fin=${pages.stopReason}). NO hago soft delete global.`);
      } else {
        await conn.execute(SQL.softDeleteWorksMissingFromStg);
      }
    }


  });

  // [SPLIT] completar doctor_id/clinic_id de works que llegaron antes que su doctor/clinica
  await relinkWorkReferences();

  // resultado de la busqueda de WORKS_FIND_EXTERNAL_ID
  for (const id of findIds) {
    const hits = foundIn.get(id);
    if (hits?.length) {
      logger.info(
        `Works ETL: BUSQUEDA external_id=${id} -> encontrada en ` +
          hits.map((h) => `page=${h.page}${h.code ? ` (code=${h.code})` : ""}`).join(", ")
      );
    } else {
      logger.warn(
        `Works ETL: BUSQUEDA external_id=${id} -> no aparecio en ninguna pagina ` +
          `(recorridas ${pages.pageStart}..${pages.lastPage ?? "-"}, mode=${pagingOnly ? "PAGING_ONLY" : "UPDATED_SINCE"})`
      );
    }
  }

  logger.info("Works ETL (STG): done");
}
