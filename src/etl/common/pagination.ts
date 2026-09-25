import { createHash } from "node:crypto";
import { logger } from "./logger.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pagina tal como la devuelve la API.
 * hasMore = has_more de la respuesta (true/false) o null si la API no lo manda.
 */
export type ApiPage<T> = { items: T[]; hasMore: boolean | null };

function toBoolOrNull(v: any): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}

export function toApiPage<T>(data: any): ApiPage<T> {
  return {
    items: Array.isArray(data?.items) ? (data.items as T[]) : [],
    hasMore: toBoolOrNull(data?.has_more ?? data?.hasMore),
  };
}

export type PaginateStopReason = "empty_page" | "repeated_page" | "http_404" | "page_max";

export type PaginateSummary = {
  pageStart: number;
  lastPage: number | null;
  pagesWithItems: number;
  totalItems: number;
  stopReason: PaginateStopReason;
  /** true = se llego al final real de la API (se puede confiar en que STG quedo completa). */
  complete: boolean;
};

// Si la API repite paginas ya leidas (p. ej. al pasarse del final devuelve otra vez la
// ultima), despues de estas repeticiones seguidas se asume que ya no hay mas datos.
const MAX_CONSECUTIVE_REPEATED_PAGES = 3;

// Firma de una pagina (ids en orden) para detectar paginas repetidas.
function pageSignature(items: any[]) {
  const ids = items.map((it) => it?.id ?? JSON.stringify(it)).join("|");
  return createHash("sha1").update(ids).digest("hex");
}

/**
 * Paginacion automatica: NO hay numero de pagina final quemado.
 * Recorre desde pageStart hasta que la API ya no devuelve datos:
 *   - pagina vacia -> fin (es la señal principal; asi funcionaba tambien el modo snapshot).
 *   - pagina identica a una ya leida -> se omite; si se repite 3 veces seguidas -> fin.
 *   - HTTP 404 despues de haber leido datos -> fin (complete=false, no se hace soft delete global).
 * has_more de la API solo se registra en el log: no se usa para cortar, para no perder datos
 * si la API lo reporta mal.
 * pageMax es opcional y por defecto no hay tope.
 */
export async function paginate<T>(
  fetchPage: (page: number) => Promise<ApiPage<T> | T[]>,
  onItems: (items: T[], page: number) => Promise<void>,
  opts?: {
    pageStart?: number;
    pageMax?: number;
    delayMs?: number;
    label?: string;
  }
): Promise<PaginateSummary> {
  const pageStart = opts?.pageStart ?? 0;
  const pageMax = opts?.pageMax ?? Number.POSITIVE_INFINITY;
  const delayMs = opts?.delayMs ?? 0;
  const label = opts?.label ?? "Paginacion";

  const seen = new Map<string, number>();
  let lastPage: number | null = null;
  let pagesWithItems = 0;
  let totalItems = 0;
  let consecutiveRepeated = 0;
  let prevHasMore: boolean | null = null;
  let hasMoreWarned = false;
  let stopReason: PaginateStopReason = "page_max";

  for (let page = pageStart; page <= pageMax; page++) {
    let res: ApiPage<T> | T[];
    try {
      res = await fetchPage(page);
    } catch (err: any) {
      if (err?.response?.status === 404 && pagesWithItems > 0) {
        logger.warn(`${label}: page=${page} respondio 404, se toma como fin de paginas.`);
        stopReason = "http_404";
        break;
      }
      throw err;
    }

    const items = Array.isArray(res) ? res : res?.items ?? [];
    const hasMore = Array.isArray(res) ? null : res?.hasMore ?? null;

    if (items.length === 0) {
      await onItems(items, page);
      stopReason = "empty_page";
      break;
    }

    const signature = pageSignature(items);
    const repeatedOf = seen.get(signature);
    if (repeatedOf !== undefined) {
      consecutiveRepeated += 1;
      logger.warn(
        `${label}: page=${page} es igual a page=${repeatedOf}, se omite ` +
          `(${consecutiveRepeated}/${MAX_CONSECUTIVE_REPEATED_PAGES}).`
      );
      if (consecutiveRepeated >= MAX_CONSECUTIVE_REPEATED_PAGES) {
        stopReason = "repeated_page";
        break;
      }
      if (delayMs) await sleep(delayMs);
      continue;
    }
    consecutiveRepeated = 0;
    seen.set(signature, page);

    if (prevHasMore === false && !hasMoreWarned) {
      hasMoreWarned = true;
      logger.warn(
        `${label}: la API marco has_more=false en page=${lastPage} pero page=${page} trae ${items.length} items. Se sigue paginando.`
      );
    }

    await onItems(items, page);
    lastPage = page;
    pagesWithItems += 1;
    totalItems += items.length;
    prevHasMore = hasMore;

    if (delayMs) await sleep(delayMs);
  }

  const complete = stopReason === "empty_page" || stopReason === "repeated_page";

  logger.info(
    `${label}: paginacion automatica fin=${stopReason} paginas=${pageStart}..${lastPage ?? "-"} ` +
      `(con datos=${pagesWithItems}) items=${totalItems} completa=${complete}`
  );

  return { pageStart, lastPage, pagesWithItems, totalItems, stopReason, complete };
}
