# schedule_works_order_list_etl

ETL 2 de 3. Trae el **listado de ordenes de trabajo** (`works`) y sus pacientes (`patients`) desde la API.

Separado de `schedule_works_order_etl`: la logica de `worksEtl` es la misma. Solo se agregaron validaciones
porque clinicas y doctores ahora los carga otro proceso (`schedule_clinics_doctors_etl`). Todo lo agregado esta marcado con `[SPLIT]`.

## Validaciones agregadas (src/etl/worksDependencies.ts)

1. **Antes de empezar:** si `clients` o `doctors` estan vacios, la corrida se salta con un warning (espera al ETL de clinicas/doctores).
2. **Antes del upsert:** reporta en el log los works cuya clinica o doctor aun no existe localmente.
   - Clinica faltante: el work no se inserta (regla original, protege la FK) y se reintenta en la siguiente corrida.
   - Doctor faltante: el work entra con `doctor_id = NULL` (regla original).
3. **Despues del upsert:** re-vincula `doctor_id` / `clinic_id` de los works que llegaron antes que su doctor o clinica.
4. **Transacciones (`common/tx.ts`):** si hay deadlock o lock wait timeout con otro de los ETLs, se reintenta la transaccion (max 3 intentos).

## Uso

```bash
npm install
cp .env.example .env   # completar credenciales
npm run build
npm start
```

Tablas STG que usa (solo este repo las toca): `stg_works`, `stg_patients` (migracion en `sql/`).

## Paginacion automatica (`src/etl/common/pagination.ts`)

No hay pagina final ni tamaño de pagina quemados (`*_PAGE_TO` y `*_PAGE_SIZE_STOP` ya no existen).
El ETL pide paginas desde `*_PAGE_FROM` (default 0) hasta que la API ya no devuelve datos:

- **Pagina vacia:** fin.
- **Pagina repetida:** si la API repite una pagina ya leida, se omite; con 3 repetidas seguidas se da por terminado.
- **404 despues de haber leido datos:** fin, pero la corrida queda marcada como incompleta y **no** se hace soft delete global.
- **`has_more`:** solo se registra en el log (avisa si la API lo reporta mal); no se usa para cortar, asi no se pierden datos.

## RAM y pool de conexiones (`src/db.ts`)

- El SQL que cambia de tamaño en cada lote (INSERT de N filas, `IN (...)` de N valores) va por `query`
  (`execQuery` / `conn.query`), no por `execute`. Con `execute`, mysql2 guardaba un prepared statement por cada
  tamaño distinto (hasta 16000 por conexion) y MySQL los mantenia abiertos: eso era lo que subia la RAM.
- El pool esta acotado: `DB_POOL_LIMIT` (5), `DB_POOL_MAX_IDLE` (2, las demas se cierran a los 60s) y
  `DB_MAX_PREPARED_STATEMENTS` (50).
- Con `ETL_RUN_ONCE=1` el pool se cierra al terminar, asi el proceso sale solo. Con SIGINT/SIGTERM tambien se cierra.

## Fecha de envio y estado: siempre desde el detalle

Con `WORKS_FETCH_DETAIL_FOR_DELIVERY=1` cada orden del listado consulta `/works/{id}`
(`WORKS_DETAIL_CONCURRENCY` consultas simultaneas) y:

- **works (padre):** `status` y `status_name` del detalle; `estimated_delivery` = `delivery_note_date`
  (fecha de envio; NULL si la orden aun no se envia). Las demas fechas son las del listado.
  Paciente, clinica y doctor del detalle solo si el listado no los trae.
- **external_work_details (hijo):** se guarda el detalle completo (tambien tareas, productos, tags y lotes)
  de las ordenes que ya existen en `works`. Las ordenes nuevas las crea el ETL de detalle en su siguiente vuelta.
  `src/etl/detailStore.ts` es copia del guardado del repo `schedule_works_order_details_etl`: si cambias uno, cambia el otro.
- Si la consulta falla, la orden conserva el status y la fecha que ya tenia en `works`.

## Velocidad

Por defecto consulta SIEMPRE el detalle de todas las ordenes (`WORKS_DETAIL_ONLY_CHANGED=0`). Para que sea rapido:

- Se piden `WORKS_PAGE_CONCURRENCY` (8) paginas del listado a la vez y se procesan varias paginas al mismo tiempo,
  sin pausa fija entre paginas (`WORKS_PAGE_DELAY_MS`=0).
- `WORKS_DETAIL_CONCURRENCY` = MAXIMO de consultas al detalle al mismo tiempo en toda la corrida (default en `.env`: 32).
  Es lo que mas influye: tiempo aproximado = ordenes x latencia del detalle / concurrencia.
- `WORKS_DETAIL_ADAPTIVE=1` (default): la concurrencia se ajusta sola para ir rapido sin saturar la API. Arranca en 8
  y sube (rapido hasta la primera saturacion, luego de 1 en 1 y mas despacio cerca de donde se saturo antes), hasta
  `WORKS_DETAIL_CONCURRENCY`. Deja de subir si la API empieza a responder el doble de lento que lo normal y baja al
  70 % si responde 503/429 o se tarda demasiado (log `API saturada (status=503) -> concurrencia detalle 32 -> 22`).
  `WORKS_DETAIL_ADAPTIVE=0` = concurrencia fija.
- Si la API se satura (429/502/503/504, timeout) o no hay internet: pausa global (ninguna consulta sale) de 1 s,
  luego 2, 4, 8, 16 y 20 s maximo si sigue saturada (log `API saturada o sin respuesta ...: todas las consultas
  esperan Xs`), y cada consulta se reintenta SIN LIMITE de intentos hasta que la API responda. Solo se deja de
  reintentar una consulta con 502/504/timeout que falla 10 veces mientras la API si responde a las demas (una orden
  puntual con problema), para no trabar el ETL; esa orden conserva lo que ya tenia en la base de datos.
- Las paginas del listado (`/works?page=N`) nunca se dejan de reintentar (si se pierde una, se cae toda la vuelta).
- Si una vuelta falla, sus consultas pendientes a la API se cancelan y se espera a que paren antes de terminar, para
  que no sigan cargando la API mientras arranca la siguiente vuelta (1 minuto despues).
- El detalle se guarda en `external_work_details` en lotes de `WORKS_DETAIL_SAVE_BATCH` (500), de uno en uno.
- `WORKS_PARTIAL_UPSERT_EVERY_PAGES` (0): en PAGING_ONLY solo se aplica a `works` al final.
- Cada 20 paginas: `Works ETL: progreso paginas=... ritmo=N ordenes/min latencia detalle promedio=Xs ...`.
  Si al subir la concurrencia la latencia promedio tambien sube, la API ya no da mas.
- `WORKS_DETAIL_ONLY_CHANGED=1` (opcional) consulta solo nuevas, cambiadas en el listado o abiertas.

El log de cada pagina muestra `detalles consultados=X/Y guardados en external_work_details=Z (Ns)`.
