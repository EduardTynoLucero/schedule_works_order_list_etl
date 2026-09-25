import axios from "axios";
import { config } from "../../config.js";
import { logger } from "./logger.js";

const token = (config.api.token ?? "").trim(); // <-- clave: sin espacios ni saltos

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableHttpError(error: any) {
  const status = error?.response?.status;
  const code = error?.code;

  return (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    code === "EAI_AGAIN"
  );
}

export const http = axios.create({
  baseURL: config.api.baseUrl,
  timeout: 60000,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    // EXACTAMENTE como Postman:
    "X-Session-Token": token,
  },
});

http.interceptors.response.use(
  (response) => response,
  async (error) => {
    const requestConfig = error?.config;
    if (!requestConfig || !isRetryableHttpError(error)) throw error;

    const maxRetries = 5;
    requestConfig.__retryCount = requestConfig.__retryCount ?? 0;

    if (requestConfig.__retryCount >= maxRetries) throw error;

    requestConfig.__retryCount += 1;
    const delayMs = Math.min(30_000, 1_000 * Math.pow(2, requestConfig.__retryCount - 1));

    logger.warn(
      `HTTP retry ${requestConfig.__retryCount}/${maxRetries} ${requestConfig.method?.toUpperCase() ?? "GET"} ` +
        `${requestConfig.url} status=${error?.response?.status ?? error?.code ?? "unknown"} wait=${delayMs}ms`
    );

    await sleep(delayMs);
    return http(requestConfig);
  }
);
