-- Medical Imaging Platform - Database Initialization
-- Place at: C:\medical-imaging-platform\scripts\init-db.sql
-- Phase 1: Environment Setup
-- Phase 4: Collaboration Features
-- CORRECTED: Added updated_by column to annotations table
--
-- This script runs automatically on first PostgreSQL startup
-- when mounted to /docker-entrypoint-initdb.d/

-- ============================================
-- Sessions Table
-- Tracks collaboration sessions
-- ============================================
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) UNIQUE NOT NULL,
    study_instance_uid VARCHAR(255) NOT NULL,
    creator_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_study ON sessions(study_instance_uid);
CREATE INDEX IF NOT EXISTS idx_sessions_creator ON sessions(creator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- ============================================
-- Annotations Table
-- Stores annotation data in JSONB format
-- FIXED: Added updated_by column
-- ============================================
CREATE TABLE IF NOT EXISTS annotations (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) REFERENCES sessions(session_id) ON DELETE CASCADE,
    annotation_id VARCHAR(255) UNIQUE NOT NULL,
    data JSONB NOT NULL,
    created_by VARCHAR(255),
    updated_by VARCHAR(255),          -- ADDED: Track who last updated the annotation
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_annotations_session ON annotations(session_id);
CREATE INDEX IF NOT EXISTS idx_annotations_id ON annotations(annotation_id);
CREATE INDEX IF NOT EXISTS idx_annotations_data ON annotations USING GIN(data);
CREATE INDEX IF NOT EXISTS idx_annotations_created_by ON annotations(created_by);
CREATE INDEX IF NOT EXISTS idx_annotations_updated_by ON annotations(updated_by);

-- ============================================
-- Session Participants Table
-- Tracks who's in each collaboration session
-- ============================================
CREATE TABLE IF NOT EXISTS session_participants (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) REFERENCES sessions(session_id) ON DELETE CASCADE,
    user_id VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    joined_at TIMESTAMP DEFAULT NOW(),
    left_at TIMESTAMP,
    -- Add unique constraint to prevent duplicate active participants
    CONSTRAINT unique_active_participant UNIQUE (session_id, user_id, joined_at)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_participants_session ON session_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON session_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_participants_active ON session_participants(session_id) WHERE left_at IS NULL;

-- ============================================
-- Viewport States Table
-- Stores viewport configuration for session persistence
-- ============================================
CREATE TABLE IF NOT EXISTS viewport_states (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) REFERENCES sessions(session_id) ON DELETE CASCADE,
    viewport_data JSONB NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_viewport_session ON viewport_states(session_id);

-- ============================================
-- Success Message
-- ============================================
DO $$
BEGIN
    RAISE NOTICE 'Medical Imaging Platform database initialized successfully';
    RAISE NOTICE 'Tables created: sessions, annotations, session_participants, viewport_states';
    RAISE NOTICE 'FIXED: annotations table now includes updated_by column';
END $$;
