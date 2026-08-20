CREATE TABLE IF NOT EXISTS inference_results (
  id BIGSERIAL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  generation_id UUID NOT NULL,
  condition TEXT NOT NULL,
  provenance_category TEXT NOT NULL,
  checkpoint_sha256 TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id, generation_id)
);

CREATE INDEX IF NOT EXISTS idx_inference_results_case_created
  ON inference_results(case_id, created_at DESC);
