CREATE TABLE IF NOT EXISTS stg_patients (
  stg_patient_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_key VARCHAR(64) NULL,
  work_external_id BIGINT NULL,
  clinic_external_id BIGINT NULL,
  name VARCHAR(255) NULL,
  age INT NULL,
  sex VARCHAR(50) NULL,
  sex_name VARCHAR(100) NULL,
  PRIMARY KEY (stg_patient_id),
  INDEX idx_stg_patients_patient_key (patient_key),
  INDEX idx_stg_patients_work_external_id (work_external_id),
  INDEX idx_stg_patients_clinic_external_id (clinic_external_id)
);

SET @db_name = DATABASE();

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE stg_patients ADD COLUMN patient_key VARCHAR(64) NULL AFTER stg_patient_id',
    'SELECT ''stg_patients.patient_key already exists'''
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'stg_patients'
    AND COLUMN_NAME = 'patient_key'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE stg_patients ADD COLUMN work_external_id BIGINT NULL AFTER patient_key',
    'SELECT ''stg_patients.work_external_id already exists'''
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'stg_patients'
    AND COLUMN_NAME = 'work_external_id'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE stg_patients ADD COLUMN clinic_external_id BIGINT NULL AFTER work_external_id',
    'SELECT ''stg_patients.clinic_external_id already exists'''
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'stg_patients'
    AND COLUMN_NAME = 'clinic_external_id'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX idx_stg_patients_patient_key ON stg_patients(patient_key)',
    'SELECT ''idx_stg_patients_patient_key already exists'''
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'stg_patients'
    AND INDEX_NAME = 'idx_stg_patients_patient_key'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX idx_stg_patients_work_external_id ON stg_patients(work_external_id)',
    'SELECT ''idx_stg_patients_work_external_id already exists'''
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'stg_patients'
    AND INDEX_NAME = 'idx_stg_patients_work_external_id'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX idx_stg_patients_clinic_external_id ON stg_patients(clinic_external_id)',
    'SELECT ''idx_stg_patients_clinic_external_id already exists'''
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'stg_patients'
    AND INDEX_NAME = 'idx_stg_patients_clinic_external_id'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE patients ADD COLUMN patient_key VARCHAR(64) NULL AFTER patient_id',
    'SELECT ''patients.patient_key already exists'''
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'patients'
    AND COLUMN_NAME = 'patient_key'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE UNIQUE INDEX uq_patients_patient_key ON patients(patient_key)',
    'SELECT ''uq_patients_patient_key already exists'''
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'patients'
    AND INDEX_NAME = 'uq_patients_patient_key'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
