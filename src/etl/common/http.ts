import axios from "axios";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { config } from "../../config.js";
import { logger } from "./logger.js";

const token = (config.api.token ?? "").trim(); // <-- clave: sin espacios ni saltos

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// [SATURACION] La API esta saturada o tarda demasiado en responder.
function overloadReason(error: any): string | null {
  const status = error?.response?.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) return `status=${status}`;
  const code = error?.code;
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ECONNRESET") return code;
  return null;
}

// [SATURACION] Sin internet o no se llega al servidor.
function networkReason(error: any): string | null {
  const code = error?.code;
  const codes = ["EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ENETDOWN"];
  return codes.includes(code) ? code : null;
}

// 429/503 y falta de internet = la API (o la red) no esta disponible: se reintenta SIN LIMITE hasta que responda.
// 502/504/timeout pueden ser de una orden puntual (p. ej. un detalle que siempre truena): si esa consulta falla
// GIVE_UP_TRIES veces mientras la API SI responde a otras, se deja de reintentar para no trabar el ETL.
const GIVE_UP_TRIES = 10;
function neverGiveUp(error: any) {
  const status = error?.response?.status;
  return status === 429 || status === 503 || Boolean(networkReason(error));
}

// [ADAPTATIVO] avisa cuando la API responde que esta saturada, para que el ETL baje solo la cantidad de
// consultas simultaneas
// sentAt = cuando se envio la consulta que fallo (para no reaccionar dos veces a la misma rafaga)
type OverloadListener = (reason: string, sentAt: number) => void;
const overloadListeners = new Set<OverloadListener>();
export function onApiOverload(listener: OverloadListener) {
  overloadListeners.add(listener);
  return () => overloadListeners.delete(listener);
}

// [SATURACION] Pausa global: cuando la API se satura (o no hay internet) NINGUNA consulta nueva (listado ni detalle)
// sale hasta que termina la pausa. Si al reanudar sigue saturada, la siguiente pausa es mas larga
// (1, 2, 4, 8, 16, 20 s como maximo); cuando vuelve a responder bien, las pausas vuelven a ser cortas.
let pausedUntil = 0;
let pauseLevel = 0;
let lastSuccessAt = 0;
const pauseStats = { pausas: 0, pausadoMs: 0 };

export function apiPauseStats() {
  return { ...pauseStats };
}
export function resetApiPauseStats() {
  pauseStats.pausas = 0;
  pauseStats.pausadoMs = 0;
}

function pauseApi(reason: string, sentAt: number) {
  const now = Date.now();
  if (now < pausedUntil) return; // ya hay pausa: los demas errores de la misma rafaga no la alargan
  if (sentAt < pausedUntil) return; // consulta enviada antes de la ultima pausa: su error ya se tomo en cuenta
  pauseLevel = Math.min(pauseLevel + 1, 6);
  const ms = Math.round(Math.min(20_000, 1_000 * 2 ** (pauseLevel - 1)) * (0.75 + Math.random() * 0.5));
  pausedUntil = now + ms;
  pauseStats.pausas += 1;
  pauseStats.pausadoMs += ms;
  logger.warn(
    `API saturada o sin respuesta (${reason}): todas las consultas esperan ${(ms / 1000).toFixed(1)}s y se reintentan`
  );
}

async function waitWhilePaused() {
  while (Date.now() < pausedUntil) await sleep(pausedUntil - Date.now());
}

// [VELOCIDAD] Reutiliza las conexiones a la API (keep-alive). En Node 18 (el que usa Dokploy/Nixpacks)
// no viene activado por defecto y cada consulta abria una conexion HTTPS nueva (handshake TLS).
// alcanza para todas las consultas simultaneas (paginas + detalles) sin hacer cola en el agente
const maxSockets = Math.max(
  64,
  config.paging.works.detailConcurrency + config.paging.works.pageConcurrency + 8
);
const keepAlive = { keepAlive: true, maxSockets, maxFreeSockets: maxSockets };

export const http = axios.create({
  baseURL: config.api.baseUrl,
  timeout: 60000,
  httpAgent: new HttpAgent(keepAlive),
  httpsAgent: new HttpsAgent(keepAlive),
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    // EXACTAMENTE como Postman:
    "X-Session-Token": token,
  },
});

// [SATURACION] ninguna consulta sale mientras dure una pausa por saturacion
http.interceptors.request.use(async (requestConfig) => {
  await waitWhilePaused();
  (requestConfig as any).__sentAt = Date.now();
  return requestConfig;
});

http.interceptors.response.use(
  (response) => {
    lastSuccessAt = Date.now();
    if (pauseLevel > 0 && lastSuccessAt >= pausedUntil) pauseLevel -= 1;
    return response;
  },
  async (error) => {
    const requestConfig = error?.config;
    const overload = overloadReason(error);
    const reason = overload ?? networkReason(error);
    if (!requestConfig || !reason) throw error;

    const now = Date.now();
    requestConfig.__retryCount = (requestConfig.__retryCount ?? 0) + 1;
    requestConfig.__firstErrorAt = requestConfig.__firstErrorAt ?? now;
    const tries = requestConfig.__retryCount;
    const label = `${requestConfig.method?.toUpperCase() ?? "GET"} ${requestConfig.url}`;

    if (!neverGiveUp(error) && tries >= GIVE_UP_TRIES && lastSuccessAt > requestConfig.__firstErrorAt) {
      logger.warn(
        `HTTP ${label} se deja de reintentar: fallo ${tries} veces (${reason}) mientras la API si respondia a otras consultas`
      );
      throw error;
    }

    const sentAt = requestConfig.__sentAt ?? 0;
    if (overload) for (const listener of overloadListeners) listener(overload, sentAt);
    pauseApi(reason, sentAt);

    // la espera larga la da la pausa global; cada consulta espera ademas entre 0.25 y 1.25 s (distinto para cada una)
    // para que al terminar la pausa no salgan todas juntas
    const delayMs = Math.round(250 + Math.random() * 1_000);
    if (tries === 1 || tries % 5 === 0) {
      logger.warn(`HTTP retry ${tries} ${label} ${reason} wait=${delayMs}ms (reintenta hasta que la API responda)`);
    }

    await sleep(delayMs);
    return http(requestConfig);
  }
);
