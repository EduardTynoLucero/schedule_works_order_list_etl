import { http } from "../common/http.js";
import { WorkItem, WorksResponse } from "../../types/worksApi.js";

export async function fetchWorksPage(page: number, updatedSince?: string | null) {
  const params = updatedSince ? { updated_since: updatedSince, page } : { page };
  const { data } = await http.get<WorksResponse>("/works", { params });
  return data?.items ?? [];
}

export async function fetchWorkDetail(id: number) {
  const { data } = await http.get<any>(`/works/${id}`);
  return (data?.item ?? data ?? null) as WorkItem | null;
}
