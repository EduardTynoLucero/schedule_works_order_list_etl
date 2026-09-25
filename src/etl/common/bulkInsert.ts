import { exec } from "../../db.js";

export async function bulkInsert(
  table: string,
  columns: string[],
  rows: any[][],
  chunkSize = 500
) {
  if (!rows.length) return;

  const colsSql = columns.map((c) => `\`${c}\``).join(", ");
  const placeholdersRow = `(${columns.map(() => "?").join(",")})`;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const sql = `
      INSERT INTO ${table} (${colsSql})
      VALUES ${chunk.map(() => placeholdersRow).join(",")}
    `;
    await exec(sql, chunk.flat());
  }
}
