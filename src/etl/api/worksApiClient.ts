import { http } from "../common/http.js";
import { ApiPage, toApiPage } from "../common/pagination.js";
import { WorkItem, WorksResponse } from "../../types/worksApi.js";

// Pagina + has_more (para que el ETL detecte solo cuantas paginas hay)
export async function fetchWorksPageWithMeta(
  page: number,
  updatedSince?: string | null
): Promise<ApiPage<WorkItem>> {
  const params = updatedSince ? { updated_since: updatedSince, page } : { page };
  const { data } = await http.get<WorksResponse>("/works", { params });
  return toApiPage<WorkItem>(data);
}

export async function fetchWorksPage(page: number, updatedSince?: string | null) {
  return (await fetchWorksPageWithMeta(page, updatedSince)).items;
}

export async function fetchWorkDetail(id: number) {
  const { data } = await http.get<any>(`/works/${id}`);
  return (data?.item ?? data ?? null) as WorkItem | null;
}
