export const logger = {
  info: (msg: string, extra?: any) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`, extra ?? ""),
  warn: (msg: string, extra?: any) => console.warn(`[WARN] ${new Date().toISOString()} ${msg}`, extra ?? ""),
  error: (msg: string, extra?: any) => console.error(`[ERR ] ${new Date().toISOString()} ${msg}`, extra ?? "")
};
