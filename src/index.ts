import { config } from "./config.js";
import { logger } from "./etl/common/logger.js";
import { inExecutionWindow, todayMidnightISO } from "./etl/common/time.js";
import { worksEtl } from "./etl/worksEtl.js";

// [SPLIT] ETL 2/3: listado de ordenes de trabajo (works + patients).
// Depende de que schedule_clinics_doctors_etl ya haya cargado clients / doctors.
// El detalle de cada orden corre en schedule_works_order_details_etl.

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let running = false;

async function runOnce() {
  if (running) {
    logger.warn("ETL ya está corriendo. Skip.");
    return;
  }
  running = true;

  try {
    if (!inExecutionWindow(config.tz)) {
      logger.info("Fuera de ventana (7AM-10PM Guatemala).");
      return;
    }

    const updatedSince = config.etl.forceUpdatedSince || todayMidnightISO(config.tz);
    logger.info(`ETL works run. mode=${config.etl.mode} updated_since=${updatedSince}`);

    await worksEtl(updatedSince);

    logger.info("ETL OK");
  } catch (err: any) {
    logger.error("ETL ERROR", err?.stack ?? err?.message ?? err);
  } finally {
    running = false;
  }
}

async function mainLoop() {
  logger.info(`Loop iniciado (works). tz=${config.tz}. Ejecuta al terminar + espera 1 minuto.`);
  while (true) {
    await runOnce();
    await sleep(60_000);
  }
}

if (config.etl.runOnce) {
  runOnce().catch((e) => logger.error("FATAL", e));
} else {
  mainLoop().catch((e) => logger.error("FATAL", e));
}
