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

/** [VELOCIDAD] Limita cuantas tareas corren a la vez (compartido entre paginas). */
function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    queue.shift()!();
  };
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}

// consultas al detalle en toda la corrida (todas las paginas juntas) y guardado del detalle de a uno
let detailLimiter = createLimiter(1);
let persistLock = createLimiter(1);

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
 * [ENVIO] Status y fecha de envio desde el detalle (/works/{id})
 * ---------------------------------------------------------------------
 * - works (padre): status y status_name del detalle, y estimated_delivery = delivery_note_date
 *   (fecha de envio; NULL si la orden aun no se envia). Las demas fechas son las del listado.
 *   Paciente, clinica y doctor del detalle solo si el listado no los trae.
 * - external_work_details (hijo): se guarda el detalle completo (tambien tareas, productos, tags y
 *   lotes) de las ordenes que ya existen en works. Las ordenes nuevas las crea el ETL de detalle.
 *
 * [VELOCIDAD] Con WORKS_DETAIL_ONLY_CHANGED=1 solo se consulta el detalle cuando puede haber cambiado:
 *   - orden nueva (no esta en works) o sin fila en external_work_details
 *   - su fila del listado cambio desde la ultima vuelta (status, fechas...)
 *   - orden abierta (todavia sin fecha de envio): como maximo cada WORKS_OPEN_RECHECK_MINUTES
 *   - sin paciente en el listado y todavia no se le consulto el detalle
 * Las demas (ya enviadas y sin cambios) conservan el status y la fecha que ya tienen en works: ya
 * salieron del detalle y no se usan los del listado.
 * Con WORKS_DETAIL_ONLY_CHANGED=0 se consulta el detalle de todas las ordenes.
 * ===================================================================== */

type WorkState = {
  workId: number;
  status: string | null;
  statusName: string | null;
  estimatedDelivery: string | null;
  hasDetail: boolean;
  hasDelivery: boolean;
};

type DetailValues = {
  status: string | null;
  statusName: string | null;
  deliveryNoteDate: string | null; // YYYY-MM-DD
};

// Ultima version vista de cada orden en el listado (en memoria; se pierde si el proceso reinicia).
// at = cuando se consulto su detalle por ultima vez (0 = nunca en este proceso).
const seenList = new Map<number, { sig: string; at: number }>();

export type DetailStats = {
  consultados: number;
  fallidos: number;
  guardados: number;
  omitidos: number;
  motivos: Record<string, number>;
  apiMs: number; // suma de lo que tardo cada consulta al detalle
  dbSaveMs: number; // tiempo guardando detalles en la BD
  paginas: number;
  ordenes: number;
};

export function newDetailStats(): DetailStats {
  return { consultados: 0, fallidos: 0, guardados: 0, omitidos: 0, motivos: {}, apiMs: 0, dbSaveMs: 0, paginas: 0, ordenes: 0 };
}

function listSignature(w: WorkItem) {
  return [w.status, w.status_name, w.finish_date, w.estimated_delivery, w.accept_date]
    .map((v) => String(v ?? ""))
    .join("|");
}

/** Lo que ya hay en works / external_work_details para estas ordenes. */
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
      has_detail: number;
      has_delivery: number;
    }>
  >(
    `
      SELECT w.work_id, w.external_id, w.status, w.status_name,
             DATE_FORMAT(w.estimated_delivery, '%Y-%m-%d %H:%i:%s') AS estimated_delivery,
             (d.work_external_id IS NOT NULL) AS has_detail,
             (d.delivery_note_date IS NOT NULL) AS has_delivery
      FROM works w
      LEFT JOIN external_work_details d ON d.work_external_id = w.external_id
      WHERE w.external_id IN (?)
    `,
    [ids]
  );

  for (const row of rows) {
    state.set(Number(row.external_id), {
      workId: Number(row.work_id),
      status: cleanText(row.status),
      statusName: cleanText(row.status_name),
      estimatedDelivery: cleanText(row.estimated_delivery),
      hasDetail: Number(row.has_detail) === 1,
      hasDelivery: Number(row.has_delivery) === 1,
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

/** Sin detalle nuevo: conservar lo que ya hay en works (el status y la fecha del listado no sirven). */
function withCurrentValues(w: WorkItem, current?: WorkState): WorkItem {
  if (!current) return { ...w, estimated_delivery: null };
  return {
    ...w,
    status: current.status ?? w.status,
    status_name: current.statusName ?? w.status_name,
    estimated_delivery: current.estimatedDelivery,
  };
}

/** Motivo para consultar el detalle de esta orden, o null si no hace falta. */
function detailReason(w: WorkItem, current: WorkState | undefined, sig: string, now: number): string | null {
  const works = config.paging.works;
  if (!works.fetchDetailForDelivery) {
    return works.fetchDetailsWhenMissingPatient && needsWorkDetail(w) ? "sin_paciente" : null;
  }
  if (!works.detailOnlyChanged) return "siempre";

  const seen = seenList.get(Number(w.id));
  if (!current) return "nueva";
  if (!current.hasDetail) return "sin_detalle";
  if (seen && seen.sig !== sig) return "cambio_en_listado";
  if (!current.hasDelivery && (!seen || now - seen.at >= works.openRecheckMinutes * 60_000)) return "abierta";
  if (works.fetchDetailsWhenMissingPatient && needsWorkDetail(w) && !seen) return "sin_paciente";
  return null;
}

// detalles consultados pendientes de guardar en external_work_details
let saveBuffer: DetailResult[] = [];

async function flushSaves(stats: DetailStats) {
  if (!saveBuffer.length) return;
  const batch = saveBuffer;
  saveBuffer = [];
  await persistLock(async () => {
    const t0 = Date.now();
    await persistDetails(batch);
    stats.dbSaveMs += Date.now() - t0;
  });
}

async function enrichWorksWithDetail(items: WorkItem[], page: number, stats: DetailStats) {
  const works = config.paging.works;
  if (!works.fetchDetailForDelivery && !works.fetchDetailsWhenMissingPatient) return items;

  const startedAt = Date.now();
  const ids = uniqueNumbers(items.map((w) => (Number.isFinite(Number(w.id)) ? Number(w.id) : null)));
  const state = await loadWorksState(ids);

  type Plan = { w: WorkItem; sig: string; reason: string | null };
  const plans: Plan[] = items.map((w) => {
    const sig = listSignature(w);
    return { w, sig, reason: w.id ? detailReason(w, state.get(Number(w.id)), sig, startedAt) : null };
  });

  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  const toSave: DetailResult[] = [];
  const enrichedItems = await mapWithConcurrency(plans, plans.length, async (p) => {
    const id = Number(p.w.id);
    const current = state.get(id);

    if (!p.reason) {
      skipped += 1;
      if (id && !seenList.has(id)) seenList.set(id, { sig: p.sig, at: 0 });
      return works.fetchDetailForDelivery ? withCurrentValues(p.w, current) : p.w;
    }

    stats.motivos[p.reason] = (stats.motivos[p.reason] ?? 0) + 1;
    try {
      const detail = await detailLimiter(async () => {
        const t0 = Date.now();
        try {
          return await fetchWorkDetail(p.w.id);
        } finally {
          stats.apiMs += Date.now() - t0;
        }
      });
      if (!detail?.id) throw new Error("detalle vacio");
      fetched += 1;
      seenList.set(id, { sig: p.sig, at: Date.now() });

      if (current) toSave.push({ ref: { work_id: current.workId, external_id: id }, detail });
      return withDetailValues(p.w, detailValuesOf(detail), detail);
    } catch (err: any) {
      failed += 1;
      logger.warn(
        `Works ETL: no pude cargar detalle work_id=${p.w.id} ` +
          `status=${err?.response?.status ?? err?.code ?? err?.message ?? "unknown"}`
      );
      return works.fetchDetailForDelivery ? withCurrentValues(p.w, current) : p.w;
    }
  });

  // hijo: detalle completo (external_work_details + tareas, productos, tags, lotes)
  // [VELOCIDAD] el detalle se junta y se guarda en lotes grandes (WORKS_DETAIL_SAVE_BATCH), de uno en uno
  if (toSave.length) {
    saveBuffer.push(...toSave);
    if (saveBuffer.length >= works.detailSaveBatch) await flushSaves(stats);
  }

  stats.consultados += fetched;
  stats.fallidos += failed;
  stats.guardados += toSave.length;
  stats.omitidos += skipped;

  if (failed) {
    logger.info(
      `Works ETL: page=${page} detalles consultados=${fetched}` +
        (failed ? ` failed=${failed}` : "") +
        ` guardados en external_work_details=${toSave.length} sin cambios=${skipped}` +
        ` (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
    );
  }

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

// ordenes ya intentadas por el backfill de pacientes -> cuando (en memoria)
const backfillTried = new Map<number, number>();

async function backfillMissingPatientsFromDetails() {
  if (!config.paging.works.backfillMissingPatients) return;

  const limit = Math.max(0, config.paging.works.backfillMissingPatientsLimit);
  if (!limit) return;
  const limitSql = Math.trunc(limit);

  const missingWorksAll = await exec<Array<{ external_id: number }>>(
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

  // [VELOCIDAD] no volver a intentar en cada vuelta las mismas ordenes (p. ej. las que dan 404)
  const retryMs = Math.max(0, config.paging.works.backfillRetryHours) * 3_600_000;
  const nowMs = Date.now();
  const missingWorks = missingWorksAll.filter(({ external_id }) => {
    const last = backfillTried.get(Number(external_id));
    return !last || nowMs - last >= retryMs;
  });
  for (const { external_id } of missingWorks) backfillTried.set(Number(external_id), nowMs);
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

function logProgress(stats: DetailStats, startedAt: number) {
  const minutes = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
  const calls = stats.consultados + stats.fallidos;
  logger.info(
    `Works ETL: progreso paginas=${stats.paginas} ordenes=${stats.ordenes} ` +
      `ritmo=${Math.round(stats.ordenes / minutes)} ordenes/min ` +
      `detalles=${stats.consultados} fallidos=${stats.fallidos} ` +
      `latencia detalle promedio=${calls ? (stats.apiMs / calls / 1000).toFixed(2) : "0"}s ` +
      `concurrencia detalle=${config.paging.works.detailConcurrency} ` +
      `tiempo guardando detalle=${Math.round(stats.dbSaveMs / 1000)}s`
  );
}

export async function worksEtl(updatedSince: string) {
  logger.info("Works ETL (STG): start");
  const runStartedAt = Date.now();
  const detailStats = newDetailStats();
  detailLimiter = createLimiter(Math.max(1, config.paging.works.detailConcurrency));
  persistLock = createLimiter(1);
  saveBuffer = [];

  // [VELOCIDAD] varias paginas se procesan a la vez (detalle + staging) mientras llegan las siguientes
  const pageWorkers = Math.max(1, config.paging.works.pageConcurrency);
  const inProgress = new Set<Promise<void>>();
  let pageError: unknown = null;
  const waitPages = async (max: number) => {
    while (inProgress.size > max) await Promise.race(inProgress);
    if (pageError) throw pageError;
  };

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

      const task: Promise<void> = (async () => {
        const works = await enrichWorksWithDetail(items, page, detailStats);
        await stageWorks(works);
      })()
        .catch((err) => {
          pageError ??= err;
        })
        .finally(() => {
          inProgress.delete(task);
          detailStats.paginas += 1;
          detailStats.ordenes += items.length;
          if (detailStats.paginas % 20 === 0) logProgress(detailStats, runStartedAt);
        });
      inProgress.add(task);
      await waitPages(pageWorkers - 1);

      // [VELOCIDAD] upserts parciales opcionales (WORKS_PARTIAL_UPSERT_EVERY_PAGES; 0 = solo al final)
      const partialEvery = Math.max(0, Math.trunc(config.paging.works.partialUpsertEveryPages));
      if (pagingOnly && partialEvery && (page - pageStart + 1) % partialEvery === 0) {
        await waitPages(0);
        await upsertWorksAndPatientsFromStg(`page=${page}`);
      }
    },
    {
      pageStart,
      label: "Works ETL",
      // [VELOCIDAD] varias paginas del listado a la vez; sin pausa fija entre paginas
      prefetch: config.paging.works.pageConcurrency,
      delayMs: config.paging.works.pageDelayMs,
    }
  );

  // terminar las paginas que siguen en proceso y guardar los detalles pendientes
  await waitPages(0);
  await flushSaves(detailStats);

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

  logger.info(
    `Works ETL: resumen paginas=${pages.pagesWithItems} ordenes=${pages.totalItems} ` +
      `detalles consultados=${detailStats.consultados} (${Object.entries(detailStats.motivos)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") || "-"}) fallidos=${detailStats.fallidos} ` +
      `guardados en external_work_details=${detailStats.guardados} sin cambios=${detailStats.omitidos} ` +
      `latencia detalle promedio=${detailStats.consultados + detailStats.fallidos ? (detailStats.apiMs / (detailStats.consultados + detailStats.fallidos) / 1000).toFixed(2) : "0"}s ` +
      `tiempo guardando detalle=${Math.round(detailStats.dbSaveMs / 1000)}s ` +
      `tiempo total=${Math.round((Date.now() - runStartedAt) / 1000)}s`
  );
  logger.info("Works ETL (STG): done");
}
