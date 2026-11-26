-- Additive schema change for Owner attendance corrections.
-- DO NOT APPLY TO THE ACTIVE DATABASE WITHOUT EXPLICIT APPROVAL.
-- This migration only creates new objects; public.attendance is not modified.

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id            TEXT PRIMARY KEY DEFAULT ('corr-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12)),
  attendance_id TEXT NOT NULL REFERENCES attendance (id) ON DELETE RESTRICT,
  corrected_by  TEXT NOT NULL REFERENCES staff_accounts (login_id) ON DELETE RESTRICT,
  before_data   JSONB NOT NULL,
  after_data    JSONB NOT NULL,
  reason        TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 1 AND 500),
  corrected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_corrections_attendance_id_idx
  ON attendance_corrections (attendance_id, corrected_at DESC);
