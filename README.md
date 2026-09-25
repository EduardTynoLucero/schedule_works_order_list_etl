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
