// src/etl/common/sql.ts
export const SQL = {
  /* ============================
     TRUNCATE STG
     ============================ */
  truncateStgWorks: `TRUNCATE TABLE stg_works;`,
  truncateStgPatients: `TRUNCATE TABLE stg_patients;`,

  /* ============================
     UPSERT PATIENTS (reactiva)
     - la API no trae patient.id; patient_key evita duplicados razonables
     ============================ */
  upsertPatientsFromStg: `
    INSERT INTO patients (
      patient_key, name, age, sex, sex_name,
      is_active, created_at, created_by, updated_at, updated_by
    )
    SELECT
      s.patient_key,
      MAX(s.name) AS name,
      MAX(s.age) AS age,
      MAX(NULLIF(s.sex, '')) AS sex,
      MAX(NULLIF(s.sex_name, '')) AS sex_name,
      1, NOW(), 'etl', NOW(), 'etl'
    FROM stg_patients s
    WHERE s.patient_key IS NOT NULL
      AND s.patient_key <> ''
      AND s.name IS NOT NULL
      AND s.name <> ''
    GROUP BY s.patient_key
    ON DUPLICATE KEY UPDATE
      patient_key = COALESCE(patient_key, VALUES(patient_key)),
      name = VALUES(name),
      age = VALUES(age),
      sex = VALUES(sex),
      sex_name = VALUES(sex_name),
      is_active = 1,
      updated_at = NOW(),
      updated_by = 'etl';
  `,

  /* ============================
     UPSERT WORKS (reactiva)
     ============================ */

     upsertWorksFromStg: `
  INSERT INTO works (
    external_id, code, box, created_at_api, accepted_date, estimated_delivery, finish_date,
    status, status_name,
    clinic_id, clinic_external_id,
    doctor_id, doctor_external_id,
    patient_id,
    is_active, is_deleted, created_at, created_by, updated_at, updated_by
  )
  SELECT
    s.external_id,
    s.code,
    s.box,
    s.created_at_api,
    s.accepted_date,
    s.estimated_delivery,
    s.finish_date,
    s.status,
    s.status_name,

    c.client_id,             -- ✅ clinic_id real
    s.clinic_external_id,    -- ✅ external

    d.doctor_id,             -- ✅ doctor_id real (puede quedar NULL si no existe)
    s.doctor_external_id,

    COALESCE(p_key.patient_id, p_name.patient_id),
    1, 0, NOW(), 'etl', NOW(), 'etl'
  FROM stg_works s
  LEFT JOIN clients c
    ON c.external_id = s.clinic_external_id
  LEFT JOIN doctors d
    ON d.external_id = s.doctor_external_id
  LEFT JOIN (
    SELECT
      work_external_id,
      MAX(patient_key) AS patient_key,
      MAX(name) AS patient_name
    FROM stg_patients
    WHERE work_external_id IS NOT NULL
      AND patient_key IS NOT NULL
      AND patient_key <> ''
    GROUP BY work_external_id
  ) sp ON sp.work_external_id = s.external_id
  LEFT JOIN patients p_key
    ON p_key.patient_key = sp.patient_key
  LEFT JOIN patients p_name
    ON p_key.patient_id IS NULL
   AND p_name.name = sp.patient_name
  WHERE s.external_id IS NOT NULL

    -- ✅ IMPORTANTÍSIMO: si NO existe la clínica local, NO insertes/actualices ese work
    -- porque rompería la FK
    AND (s.clinic_external_id IS NULL OR c.client_id IS NOT NULL)

  ON DUPLICATE KEY UPDATE
    code = VALUES(code),
    box = VALUES(box),
    created_at_api = VALUES(created_at_api),
    accepted_date = VALUES(accepted_date),
    estimated_delivery = VALUES(estimated_delivery),
    finish_date = VALUES(finish_date),
    status = VALUES(status),
    status_name = VALUES(status_name),

    clinic_id = VALUES(clinic_id),
    clinic_external_id = VALUES(clinic_external_id),

    doctor_id = VALUES(doctor_id),
    doctor_external_id = VALUES(doctor_external_id),

    patient_id = COALESCE(VALUES(patient_id), works.patient_id),

    is_active = 1,
    is_deleted = 0,
    updated_at = NOW(),
    updated_by = 'etl';
`,


  softDeleteWorksMissingFromStg: `
    UPDATE works w
    LEFT JOIN (
      SELECT DISTINCT external_id
      FROM stg_works
      WHERE external_id IS NOT NULL
    ) s ON s.external_id = w.external_id
    SET w.is_active = 0,
        w.is_deleted = 1,
        w.updated_at = NOW(),
        w.updated_by = 'etl'
    WHERE s.external_id IS NULL
      AND w.is_deleted = 0;
  `,

  /* ============================
     [SPLIT] VALIDACIONES DE DEPENDENCIAS
     - clients / doctors ahora los carga otro repo (schedule_clinics_doctors_etl),
       asi que antes de tocar works se valida que existan.
     ============================ */
  catalogsReady: `
    SELECT
      EXISTS (SELECT 1 FROM clients LIMIT 1) AS has_clients,
      EXISTS (SELECT 1 FROM doctors LIMIT 1) AS has_doctors;
  `,

  // Resumen de works en STG cuya clinica / doctor todavia no existe localmente
  stgWorksMissingDependencies: `
    SELECT
      COUNT(DISTINCT CASE WHEN s.clinic_external_id IS NOT NULL AND c.client_id IS NULL THEN s.external_id END) AS works_missing_clinic,
      COUNT(DISTINCT CASE WHEN s.clinic_external_id IS NOT NULL AND c.client_id IS NULL THEN s.clinic_external_id END) AS missing_clinics,
      COUNT(DISTINCT CASE WHEN s.doctor_external_id IS NOT NULL AND d.doctor_id IS NULL THEN s.external_id END) AS works_missing_doctor,
      COUNT(DISTINCT CASE WHEN s.doctor_external_id IS NOT NULL AND d.doctor_id IS NULL THEN s.doctor_external_id END) AS missing_doctors
    FROM stg_works s
    LEFT JOIN clients c
      ON c.external_id = s.clinic_external_id
    LEFT JOIN doctors d
      ON d.external_id = s.doctor_external_id
    WHERE s.external_id IS NOT NULL;
  `,

  stgMissingClinicIdsSample: `
    SELECT DISTINCT s.clinic_external_id AS id
    FROM stg_works s
    LEFT JOIN clients c
      ON c.external_id = s.clinic_external_id
    WHERE s.external_id IS NOT NULL
      AND s.clinic_external_id IS NOT NULL
      AND c.client_id IS NULL
    LIMIT 20;
  `,

  stgMissingDoctorIdsSample: `
    SELECT DISTINCT s.doctor_external_id AS id
    FROM stg_works s
    LEFT JOIN doctors d
      ON d.external_id = s.doctor_external_id
    WHERE s.external_id IS NOT NULL
      AND s.doctor_external_id IS NOT NULL
      AND d.doctor_id IS NULL
    LIMIT 20;
  `,

  /* ============================
     [SPLIT] RE-VINCULAR REFERENCIAS
     - si un work entro antes que su doctor (doctor_id quedo NULL), cuando el
       doctor ya existe se completa doctor_id. Igual para clinic_id.
     ============================ */
  relinkWorksDoctors: `
    UPDATE works w
    JOIN doctors d
      ON d.external_id = w.doctor_external_id
    SET w.doctor_id = d.doctor_id,
        w.updated_at = NOW(),
        w.updated_by = 'etl'
    WHERE w.doctor_id IS NULL
      AND w.doctor_external_id IS NOT NULL
      AND w.is_deleted = 0;
  `,

  relinkWorksClinics: `
    UPDATE works w
    JOIN clients c
      ON c.external_id = w.clinic_external_id
    SET w.clinic_id = c.client_id,
        w.updated_at = NOW(),
        w.updated_by = 'etl'
    WHERE w.clinic_id IS NULL
      AND w.clinic_external_id IS NOT NULL
      AND w.is_deleted = 0;
  `,

};
