function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function paginate<T>(
  fetchPage: (page: number) => Promise<T[]>,
  onItems: (items: T[], page: number) => Promise<void>,
  opts?: {
    pageStart?: number;
    pageSizeStop?: number;
    pageMax?: number;
    forceRange?: boolean; // si true, NO corta por items < pageSizeStop
    delayMs?: number;
  }
) {
  const pageStart = opts?.pageStart ?? 0;
  const pageSizeStop = opts?.pageSizeStop ?? 50;
  const pageMax = opts?.pageMax ?? 999999;
  const forceRange = opts?.forceRange ?? false;
  const delayMs = opts?.delayMs ?? 0;

  for (let page = pageStart; page <= pageMax; page++) {
    const items = await fetchPage(page);
    await onItems(items, page);

    if (delayMs) await sleep(delayMs);

    if (items.length === 0) break;
    if (!forceRange && items.length < pageSizeStop) break;
  }
}
