// [ENVIO] Guardado del detalle completo de una orden (external_work_details + tareas, productos, tags,
// lotes y catalogos). COPIA de schedule_works_order_details_etl/src/etl/workDetailsEtl.ts (persistDetails):
// si cambias como se guarda el detalle, cambialo en los dos repos.
import { DateTime } from "luxon";
import { config } from "../config.js";
import { withTx } from "./common/tx.js";
import type { WorkItem, WorkProduct, WorkTag, WorkTask } from "../types/worksApi.js";

export type WorkRef = {
  work_id: number;
  external_id: number;
};

export type DetailResult = {
  ref: WorkRef;
  detail: WorkItem;
};

export function cleanText(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function toInt(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;

  const n = Number(text);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toDecimal(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;

  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function toMysqlDate(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;

  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];

  const dt = DateTime.fromISO(text, { setZone: true });
  if (dt.isValid) return dt.setZone(config.tz).toFormat("yyyy-LL-dd");

  return null;
}

export function toMysqlDateTime(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;

  const fromIso = DateTime.fromISO(text, { setZone: true });
  if (fromIso.isValid) return fromIso.setZone(config.tz).toFormat("yyyy-LL-dd HH:mm:ss");

  const fromSql = DateTime.fromSQL(text, { zone: config.tz });
  if (fromSql.isValid) return fromSql.toFormat("yyyy-LL-dd HH:mm:ss");

  return text.slice(0, 19).replace("T", " ");
}

// delivery_note_date (fecha de envio) llega como fecha "YYYY-MM-DD"; como DATETIME queda a las 00:00:00.
export function toMysqlDateTimeFromDateOnly(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`;
  return toMysqlDateTime(text);
}

function asArray<T>(value: T[] | null | undefined) {
  return Array.isArray(value) ? value : [];
}

function asJson(value: unknown) {
  return JSON.stringify(value ?? null);
}

export function uniqueNumbers(values: Array<number | null>) {
  return [...new Set(values.filter((value): value is number => value !== null))];
}

export function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function upsertRows(
  conn: any,
  table: string,
  columns: string[],
  rows: any[][],
  updateColumns: string[],
  chunkSize = 500
) {
  if (!rows.length) return;

  const colsSql = columns.map((column) => `\`${column}\``).join(", ");
  const placeholdersRow = `(${columns.map(() => "?").join(",")})`;
  const updateSql = [
    ...updateColumns.map((column) => `\`${column}\` = VALUES(\`${column}\`)`),
    "`updated_at` = CURRENT_TIMESTAMP",
  ].join(", ");

  for (const part of chunk(rows, chunkSize)) {
    const sql = `
      INSERT INTO ${table} (${colsSql})
      VALUES ${part.map(() => placeholdersRow).join(",")}
      ON DUPLICATE KEY UPDATE ${updateSql}
    `;
    // [RAM] query (no prepared statement): el numero de filas cambia en cada lote
    await conn.query(sql, part.flat());
  }
}

async function insertRows(conn: any, table: string, columns: string[], rows: any[][], chunkSize = 500) {
  if (!rows.length) return;

  const colsSql = columns.map((column) => `\`${column}\``).join(", ");
  const placeholdersRow = `(${columns.map(() => "?").join(",")})`;

  for (const part of chunk(rows, chunkSize)) {
    const sql = `
      INSERT INTO ${table} (${colsSql})
      VALUES ${part.map(() => placeholdersRow).join(",")}
    `;
    // [RAM] query (no prepared statement): el numero de filas cambia en cada lote
    await conn.query(sql, part.flat());
  }
}

async function deleteChildrenForWorks(conn: any, table: string, workExternalIds: number[]) {
  for (const part of chunk(workExternalIds, 500)) {
    const placeholders = part.map(() => "?").join(",");
    // [RAM] query: el tamaño del IN (...) cambia en cada lote
    await conn.query(`DELETE FROM ${table} WHERE work_external_id IN (${placeholders})`, part);
  }
}

async function readIdMap(
  conn: any,
  table: string,
  idColumn: string,
  externalColumn: string,
  externalIds: number[]
) {
  const map = new Map<number, number>();
  if (!externalIds.length) return map;

  for (const part of chunk(externalIds, 500)) {
    const placeholders = part.map(() => "?").join(",");
    // [RAM] query: el tamaño del IN (...) cambia en cada lote
    const [rows] = await conn.query(
      `SELECT \`${idColumn}\`, \`${externalColumn}\` FROM ${table} WHERE \`${externalColumn}\` IN (${placeholders})`,
      part
    );

    for (const row of rows as any[]) {
      const externalId = toInt(row[externalColumn]);
      const localId = toInt(row[idColumn]);
      if (externalId !== null && localId !== null) map.set(externalId, localId);
    }
  }

  return map;
}

async function readManufacturerMap(conn: any, manufacturerExternalIds: number[]) {
  const map = new Map<string, number>();
  if (!manufacturerExternalIds.length) return map;

  for (const part of chunk(manufacturerExternalIds, 500)) {
    const placeholders = part.map(() => "?").join(",");
    // [RAM] query: el tamaño del IN (...) cambia en cada lote
    const [rows] = await conn.query(
      `
        SELECT external_manufacturer_id, manufacturer_type, manufacturer_external_id
        FROM external_manufacturers
        WHERE manufacturer_external_id IN (${placeholders})
      `,
      part
    );

    for (const row of rows as any[]) {
      const externalId = toInt(row.manufacturer_external_id);
      const localId = toInt(row.external_manufacturer_id);
      const type = cleanText(row.manufacturer_type) ?? "";
      if (externalId !== null && localId !== null) map.set(`${type}|${externalId}`, localId);
    }
  }

  return map;
}

function getWorkExternalId(result: DetailResult) {
  return toInt(result.detail.id) ?? result.ref.external_id;
}

function collectCatalogRows(results: DetailResult[]) {
  const stages = new Map<number, any[]>();
  const manufacturers = new Map<string, any[]>();
  const tags = new Map<number, any[]>();
  const products = new Map<number, any[]>();

  for (const result of results) {
    const detail = result.detail;

    for (const task of asArray<WorkTask>(detail.tasks)) {
      const stageExternalId = toInt(task.stage?.id);
      const stageName = cleanText(task.stage?.name);
      if (stageExternalId !== null && stageName) {
        stages.set(stageExternalId, [stageExternalId, stageName]);
      }

      const manufacturerExternalId = toInt(task.manufacturer?.id);
      const manufacturerName = cleanText(task.manufacturer?.name);
      const manufacturerType = cleanText(task.manufacturer?.type) ?? "UNKNOWN";
      if (manufacturerExternalId !== null && manufacturerName) {
        manufacturers.set(`${manufacturerType}|${manufacturerExternalId}`, [
          manufacturerExternalId,
          manufacturerType,
          manufacturerName,
        ]);
      }
    }

    for (const tag of asArray<WorkTag>(detail.tags)) {
      const tagExternalId = toInt(tag.id);
      const tagName = cleanText(tag.name);
      if (tagExternalId !== null && tagName) {
        tags.set(tagExternalId, [tagExternalId, cleanText(tag.code), tagName]);
      }
    }

    for (const productLine of asArray<WorkProduct>(detail.products)) {
      const productExternalId = toInt(productLine.product?.id);
      const productName = cleanText(productLine.product?.name);
      if (productExternalId !== null && productName) {
        products.set(productExternalId, [
          productExternalId,
          cleanText(productLine.product?.code),
          productName,
        ]);
      }
    }
  }

  return {
    stageRows: [...stages.values()],
    manufacturerRows: [...manufacturers.values()],
    tagRows: [...tags.values()],
    productRows: [...products.values()],
  };
}

export async function persistDetails(results: DetailResult[]) {
  if (!results.length) return;

  const workExternalIds = uniqueNumbers(results.map(getWorkExternalId));
  if (!workExternalIds.length) return;

  await withTx(async (conn) => {
    const detailRows = results.map(({ ref, detail }) => {
      const workExternalId = getWorkExternalId({ ref, detail });

      return [
        ref.work_id,
        workExternalId,
        cleanText(detail.code),
        cleanText(detail.box),
        toMysqlDateTime(detail.created_at),
        toMysqlDate(detail.order_date),
        toMysqlDate(detail.accept_date),
        // estimated_delivery = delivery_note_date (fecha de envio). Si la orden aun no se envia, queda NULL.
        toMysqlDateTimeFromDateOnly(detail.delivery_note_date),
        toMysqlDateTime(detail.deadline),
        toMysqlDate(detail.finish_date),
        toMysqlDate(detail.delivery_note_date),
        cleanText(detail.status),
        cleanText(detail.status_name),
        toInt(detail.clinic?.id ?? detail.clinic_id),
        cleanText(detail.clinic?.code),
        cleanText(detail.clinic?.name),
        toInt(detail.doctor?.id ?? detail.doctor_id),
        cleanText(detail.doctor?.name),
        cleanText(detail.patient?.name ?? detail.patient_name),
        toInt(detail.patient?.age),
        cleanText(detail.patient?.sex),
        cleanText(detail.patient?.sex_name),
        cleanText(detail.observations),
        cleanText(detail.internal_notes),
        toDecimal(detail.total_price),
        toDecimal(detail.total_price_with_vat),
        asJson(detail),
        1,
        0,
      ];
    });

    await upsertRows(
      conn,
      "external_work_details",
      [
        "work_id",
        "work_external_id",
        "code",
        "box",
        "created_at_api",
        "order_date",
        "accepted_date",
        "estimated_delivery",
        "deadline",
        "finish_date",
        "delivery_note_date",
        "status",
        "status_name",
        "clinic_external_id",
        "clinic_code",
        "clinic_name",
        "doctor_external_id",
        "doctor_name",
        "patient_name",
        "patient_age",
        "patient_sex",
        "patient_sex_name",
        "observations",
        "internal_notes",
        "total_price",
        "total_price_with_vat",
        "raw_json",
        "is_active",
        "is_deleted",
      ],
      detailRows,
      [
        "work_id",
        "code",
        "box",
        "created_at_api",
        "order_date",
        "accepted_date",
        "estimated_delivery",
        "deadline",
        "finish_date",
        "delivery_note_date",
        "status",
        "status_name",
        "clinic_external_id",
        "clinic_code",
        "clinic_name",
        "doctor_external_id",
        "doctor_name",
        "patient_name",
        "patient_age",
        "patient_sex",
        "patient_sex_name",
        "observations",
        "internal_notes",
        "total_price",
        "total_price_with_vat",
        "raw_json",
        "is_active",
        "is_deleted",
      ]
    );

    const { stageRows, manufacturerRows, tagRows, productRows } = collectCatalogRows(results);

    await upsertRows(
      conn,
      "external_stages",
      ["stage_external_id", "name"],
      stageRows,
      ["name"]
    );

    await upsertRows(
      conn,
      "external_manufacturers",
      ["manufacturer_external_id", "manufacturer_type", "name"],
      manufacturerRows,
      ["manufacturer_type", "name"]
    );

    await upsertRows(
      conn,
      "external_tags",
      ["tag_external_id", "code", "name"],
      tagRows,
      ["code", "name"]
    );

    await upsertRows(
      conn,
      "external_products",
      ["product_external_id", "code", "name"],
      productRows,
      ["code", "name"]
    );

    const stageMap = await readIdMap(
      conn,
      "external_stages",
      "external_stage_id",
      "stage_external_id",
      uniqueNumbers(stageRows.map((row) => toInt(row[0])))
    );
    const manufacturerMap = await readManufacturerMap(
      conn,
      uniqueNumbers(manufacturerRows.map((row) => toInt(row[0])))
    );
    const tagMap = await readIdMap(
      conn,
      "external_tags",
      "external_tag_id",
      "tag_external_id",
      uniqueNumbers(tagRows.map((row) => toInt(row[0])))
    );
    const productMap = await readIdMap(
      conn,
      "external_products",
      "external_product_id",
      "product_external_id",
      uniqueNumbers(productRows.map((row) => toInt(row[0])))
    );

    await deleteChildrenForWorks(conn, "external_work_tasks", workExternalIds);
    await deleteChildrenForWorks(conn, "external_work_tags", workExternalIds);
    await deleteChildrenForWorks(conn, "external_work_products", workExternalIds);
    await deleteChildrenForWorks(conn, "external_work_lots", workExternalIds);

    const taskRows: any[][] = [];
    const workTagRows: any[][] = [];
    const workProductRows: any[][] = [];
    const workLotRows: any[][] = [];

    for (const result of results) {
      const workExternalId = getWorkExternalId(result);

      asArray<WorkTask>(result.detail.tasks).forEach((task, index) => {
        const taskExternalId = toInt(task.id);
        if (taskExternalId === null) return;

        const stageExternalId = toInt(task.stage?.id);
        const manufacturerExternalId = toInt(task.manufacturer?.id);
        const manufacturerType = cleanText(task.manufacturer?.type) ?? "UNKNOWN";

        taskRows.push([
          taskExternalId,
          result.ref.work_id,
          workExternalId,
          stageExternalId === null ? null : stageMap.get(stageExternalId) ?? null,
          stageExternalId,
          cleanText(task.stage?.name),
          manufacturerExternalId === null
            ? null
            : manufacturerMap.get(`${manufacturerType}|${manufacturerExternalId}`) ?? null,
          manufacturerExternalId,
          manufacturerExternalId === null ? cleanText(task.manufacturer?.type) : manufacturerType,
          cleanText(task.manufacturer?.name),
          cleanText(task.status),
          cleanText(task.status_name),
          toMysqlDateTime(task.start_date),
          toMysqlDateTime(task.finish_date),
          toMysqlDateTime(task.estimated_delivery),
          toInt(task.teeth_count),
          toDecimal(task.cost),
          toDecimal(task.commission),
          toDecimal(task.work_time),
          index + 1,
          asJson(task),
        ]);
      });

      asArray<WorkTag>(result.detail.tags).forEach((tag) => {
        const tagExternalId = toInt(tag.id);
        if (tagExternalId === null) return;

        workTagRows.push([
          workExternalId,
          tagMap.get(tagExternalId) ?? null,
          tagExternalId,
          cleanText(tag.code),
          cleanText(tag.name),
        ]);
      });

      asArray<WorkProduct>(result.detail.products).forEach((productLine, index) => {
        const productExternalId = toInt(productLine.product?.id);

        workProductRows.push([
          workExternalId,
          index + 1,
          productExternalId === null ? null : productMap.get(productExternalId) ?? null,
          productExternalId,
          cleanText(productLine.product?.code),
          cleanText(productLine.product?.name),
          cleanText(productLine.name),
          toDecimal(productLine.units),
          cleanText(productLine.teeth),
          toDecimal(productLine.price),
          toDecimal(productLine.discount),
          toDecimal(productLine.unit_price),
          toDecimal(productLine.total_price),
          toDecimal(productLine.vat),
          asJson(productLine),
        ]);
      });

      asArray<any>(result.detail.lots).forEach((lot, index) => {
        workLotRows.push([
          workExternalId,
          index + 1,
          toInt(lot?.id),
          asJson(lot),
        ]);
      });
    }

    await insertRows(
      conn,
      "external_work_tasks",
      [
        "task_external_id",
        "work_id",
        "work_external_id",
        "external_stage_id",
        "stage_external_id",
        "stage_name",
        "external_manufacturer_id",
        "manufacturer_external_id",
        "manufacturer_type",
        "manufacturer_name",
        "status",
        "status_name",
        "start_date",
        "finish_date",
        "estimated_delivery",
        "teeth_count",
        "cost",
        "commission",
        "work_time",
        "source_order",
        "raw_json",
      ],
      taskRows,
      1000
    );

    await insertRows(
      conn,
      "external_work_tags",
      ["work_external_id", "external_tag_id", "tag_external_id", "tag_code", "tag_name"],
      workTagRows,
      1000
    );

    await insertRows(
      conn,
      "external_work_products",
      [
        "work_external_id",
        "line_no",
        "external_product_id",
        "product_external_id",
        "product_code",
        "product_name",
        "name",
        "units",
        "teeth",
        "price",
        "discount",
        "unit_price",
        "total_price",
        "vat",
        "raw_json",
      ],
      workProductRows,
      1000
    );

    await insertRows(
      conn,
      "external_work_lots",
      ["work_external_id", "line_no", "lot_external_id", "raw_json"],
      workLotRows,
      1000
    );
  });
}
