CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    dataset_group   TEXT NOT NULL DEFAULT 'UPLOAD',
    channel         TEXT,
    language        TEXT,
    transcript      JSONB NOT NULL,
    audio_url       TEXT,
    raw             JSONB,
    imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_group_idx ON conversations (dataset_group);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS topic TEXT;

-- Every save of a checklist creates a new immutable version.
CREATE TABLE IF NOT EXISTS checklists (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    version     INT NOT NULL,
    config      JSONB NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT false,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evaluations (
    id               SERIAL PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    checklist_id     INT NOT NULL REFERENCES checklists(id),
    status           TEXT NOT NULL DEFAULT 'pending',      -- pending | running | done | error
    error            TEXT,
    provider         TEXT,
    model            TEXT,
    criteria         JSONB,        -- original per-criterion results from the model
    score            JSONB,        -- original computed score
    total            NUMERIC(8,2),
    critical         BOOLEAN,
    final_criteria   JSONB,        -- after reviewer decisions
    final_score      JSONB,
    final_total      NUMERIC(8,2),
    summary          TEXT,
    usage            JSONB,
    cost_usd         NUMERIC(12,6),
    duration_ms      INT,
    batch_id         INT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS evaluations_conv_idx ON evaluations (conversation_id, id DESC);

CREATE TABLE IF NOT EXISTS appeals (
    id              SERIAL PRIMARY KEY,
    evaluation_id   INT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
    criterion_id    TEXT NOT NULL,
    comment         TEXT NOT NULL,
    author          TEXT,
    status          TEXT NOT NULL DEFAULT 'open',       -- open | confirmed | changed
    original_answer JSONB,
    new_answer      JSONB,
    reason          TEXT,
    reviewer        TEXT,
    total_before    NUMERIC(8,2),
    total_after     NUMERIC(8,2),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS case_details JSONB;
ALTER TABLE checklists ADD COLUMN IF NOT EXISTS source_appeal_id INT REFERENCES appeals(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS rule_check_examples (
    checklist_name   TEXT NOT NULL,
    criterion_id     TEXT NOT NULL,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    expected_answer  JSONB NOT NULL,
    source_appeal_id INT REFERENCES appeals(id) ON DELETE SET NULL,
    PRIMARY KEY (checklist_name, criterion_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS rule_check_reports (
    candidate_id INT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
    criterion_id TEXT NOT NULL,
    snapshot     JSONB NOT NULL,
    report       JSONB NOT NULL,
    PRIMARY KEY (candidate_id, criterion_id)
);

CREATE TABLE IF NOT EXISTS batches (
    id            SERIAL PRIMARY KEY,
    dataset_group TEXT,
    checklist_id  INT REFERENCES checklists(id),
    total         INT NOT NULL DEFAULT 0,
    done          INT NOT NULL DEFAULT 0,
    failed        INT NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'running',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);

-- Versioning for accuracy tracking: what produced a batch / evaluation, and why it was run.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS pipeline JSONB;
ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS pipeline JSONB;
CREATE INDEX IF NOT EXISTS evaluations_batch_idx ON evaluations (batch_id);

CREATE TABLE IF NOT EXISTS radar_runs (
    id            SERIAL PRIMARY KEY,
    dataset_group TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'running',
    total         INT NOT NULL,
    done          INT NOT NULL DEFAULT 0,
    failed        INT NOT NULL DEFAULT 0,
    model         TEXT NOT NULL,
    error         TEXT,
    result        JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS radar_one_running_per_group_idx
    ON radar_runs (dataset_group) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS radar_tasks (
    id             SERIAL PRIMARY KEY,
    run_id         INT NOT NULL REFERENCES radar_runs(id),
    group_index    INT NOT NULL CHECK (group_index >= 0),
    title          TEXT NOT NULL,
    category       TEXT NOT NULL,
    affected_count INT NOT NULL CHECK (affected_count >= 2),
    report         TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'fixed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, group_index)
);

-- Hand-labelled reference answers per dataset group. Every upload is a new immutable version.
-- Used only to measure accuracy; never sent to the model.
CREATE TABLE IF NOT EXISTS ground_truth (
    id            SERIAL PRIMARY KEY,
    dataset_group TEXT NOT NULL,
    version       INT NOT NULL,
    labels        JSONB NOT NULL,
    meta          JSONB,
    note          TEXT,
    author        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_group, version)
);
