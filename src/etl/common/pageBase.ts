export async function detectPageBase(fetchPage: (page: number) => Promise<any[]>) {
  const p0 = await fetchPage(0);
  if (p0.length > 0) return 0;

  const p1 = await fetchPage(1);
  if (p1.length > 0) return 1;

  return 0;
}
