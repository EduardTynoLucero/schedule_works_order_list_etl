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
