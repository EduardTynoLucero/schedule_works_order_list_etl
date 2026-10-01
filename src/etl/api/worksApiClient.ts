import { http } from "../common/http.js";
import { ApiPage, toApiPage } from "../common/pagination.js";
import { WorkItem, WorksResponse } from "../../types/worksApi.js";

// Pagina + has_more (para que el ETL detecte solo cuantas paginas hay)
export async function fetchWorksPageWithMeta(
  page: number,
  updatedSince?: string | null,
  signal?: AbortSignal // [SATURACION] para cancelar las consultas de una vuelta que ya fallo
): Promise<ApiPage<WorkItem>> {
  const params = updatedSince ? { updated_since: updatedSince, page } : { page };
  const { data } = await http.get<WorksResponse>("/works", { params, signal });
  return toApiPage<WorkItem>(data);
}

export async function fetchWorksPage(page: number, updatedSince?: string | null, signal?: AbortSignal) {
  return (await fetchWorksPageWithMeta(page, updatedSince, signal)).items;
}

export async function fetchWorkDetail(id: number, signal?: AbortSignal) {
  const { data } = await http.get<any>(`/works/${id}`, { signal });
  return (data?.item ?? data ?? null) as WorkItem | null;
}
