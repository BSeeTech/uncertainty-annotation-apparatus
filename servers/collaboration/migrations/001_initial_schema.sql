-- ============================================
-- Medical Imaging Platform Database Schema
-- Version: 1.0
-- Date: 2025-11-09
-- ============================================

-- Drop existing tables if they exist (for development)
DROP TABLE IF EXISTS viewport_states CASCADE;
DROP TABLE IF EXISTS session_participants CASCADE;
DROP TABLE IF EXISTS annotations CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;

-- ============================================
-- SESSIONS TABLE
-- ============================================
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) UNIQUE NOT NULL,
    study_instance_uid VARCHAR(255) NOT NULL,
    creator_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for sessions
CREATE INDEX idx_sessions_session_id ON sessions(session_id);
CREATE INDEX idx_sessions_study ON sessions(study_instance_uid);
CREATE INDEX idx_sessions_creator ON sessions(creator_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_created_at ON sessions(created_at);

-- ============================================
-- ANNOTATIONS TABLE
-- ============================================
CREATE TABLE annotations (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    annotation_id VARCHAR(255) UNIQUE NOT NULL,
    data JSONB NOT NULL,
    created_by VARCHAR(255),
    updated_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_session
        FOREIGN KEY(session_id) 
        REFERENCES sessions(session_id) 
        ON DELETE CASCADE
);

-- Indexes for annotations
CREATE INDEX idx_annotations_session ON annotations(session_id);
CREATE INDEX idx_annotations_annotation_id ON annotations(annotation_id);
CREATE INDEX idx_annotations_created_by ON annotations(created_by);
CREATE INDEX idx_annotations_created_at ON annotations(created_at);

-- GIN index for JSONB data (enables fast JSON queries)
CREATE INDEX idx_annotations_data ON annotations USING GIN(data);

-- ============================================
-- SESSION PARTICIPANTS TABLE
-- ============================================
CREATE TABLE session_participants (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('presenter', 'follower')),
    joined_at TIMESTAMP DEFAULT NOW(),
    left_at TIMESTAMP,
    CONSTRAINT fk_session_participant
        FOREIGN KEY(session_id) 
        REFERENCES sessions(session_id) 
        ON DELETE CASCADE
);

-- Indexes for session participants
CREATE INDEX idx_participants_session ON session_participants(session_id);
CREATE INDEX idx_participants_user ON session_participants(user_id);
CREATE INDEX idx_participants_role ON session_participants(role);
CREATE INDEX idx_participants_joined_at ON session_participants(joined_at);

-- Unique constraint: user can only have one active participation per session
CREATE UNIQUE INDEX idx_active_participant 
    ON session_participants(session_id, user_id) 
    WHERE left_at IS NULL;

-- ============================================
-- VIEWPORT STATES TABLE (for persistence)
-- ============================================
CREATE TABLE viewport_states (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    viewport_data JSONB NOT NULL,
    updated_by VARCHAR(255),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_session_viewport
        FOREIGN KEY(session_id) 
        REFERENCES sessions(session_id) 
        ON DELETE CASCADE
);

-- Indexes for viewport states
CREATE INDEX idx_viewport_session ON viewport_states(session_id);
CREATE INDEX idx_viewport_updated_at ON viewport_states(updated_at);

-- ============================================
-- TRIGGERS FOR AUTO-UPDATE TIMESTAMPS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for sessions table
CREATE TRIGGER update_sessions_updated_at 
    BEFORE UPDATE ON sessions 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for annotations table
CREATE TRIGGER update_annotations_updated_at 
    BEFORE UPDATE ON annotations 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- VIEWS FOR COMMON QUERIES
-- ============================================

-- View: Active sessions with participant count
CREATE OR REPLACE VIEW active_sessions_view AS
SELECT 
    s.session_id,
    s.study_instance_uid,
    s.creator_id,
    s.created_at,
    s.updated_at,
    COUNT(DISTINCT a.id) as annotation_count,
    COUNT(DISTINCT sp.user_id) FILTER (WHERE sp.left_at IS NULL) as active_users,
    json_agg(
        DISTINCT jsonb_build_object(
            'userId', sp.user_id,
            'role', sp.role,
            'joinedAt', sp.joined_at
        )
    ) FILTER (WHERE sp.left_at IS NULL) as participants
FROM sessions s
LEFT JOIN annotations a ON s.session_id = a.session_id
LEFT JOIN session_participants sp ON s.session_id = sp.session_id
WHERE s.status = 'active'
GROUP BY s.id, s.session_id, s.study_instance_uid, s.creator_id, s.created_at, s.updated_at;

-- View: Session statistics
CREATE OR REPLACE VIEW session_statistics AS
SELECT 
    s.session_id,
    s.study_instance_uid,
    s.status,
    s.created_at,
    COUNT(DISTINCT a.id) as total_annotations,
    COUNT(DISTINCT sp.user_id) as total_participants,
    COUNT(DISTINCT sp.user_id) FILTER (WHERE sp.left_at IS NULL) as active_participants,
    MAX(a.updated_at) as last_annotation_time,
    EXTRACT(EPOCH FROM (NOW() - s.created_at)) / 60 as session_duration_minutes
FROM sessions s
LEFT JOIN annotations a ON s.session_id = a.session_id
LEFT JOIN session_participants sp ON s.session_id = sp.session_id
GROUP BY s.id, s.session_id, s.study_instance_uid, s.status, s.created_at;

-- ============================================
-- SAMPLE DATA FOR TESTING (Optional)
-- ============================================

-- Insert a test session
INSERT INTO sessions (session_id, study_instance_uid, creator_id, status)
VALUES ('test_session_001', '1.2.840.113619.2.55.3.12345', 'test_user_001', 'active');

-- Insert test participant
INSERT INTO session_participants (session_id, user_id, role)
VALUES ('test_session_001', 'test_user_001', 'presenter');

-- Insert test annotation
INSERT INTO annotations (session_id, annotation_id, data, created_by)
VALUES (
    'test_session_001',
    'annotation_test_001',
    '{
        "annotationUID": "annotation_test_001",
        "type": "RectangleROI",
        "data": {
            "handles": {
                "points": [[100, 100, 0], [200, 200, 0]]
            }
        },
        "metadata": {
            "toolName": "RectangleROI",
            "referencedImageId": "test_image_001"
        }
    }'::jsonb,
    'test_user_001'
);

-- ============================================
-- UTILITY FUNCTIONS
-- ============================================

-- Function to clean up old closed sessions (older than 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_sessions()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM sessions
    WHERE status = 'closed'
    AND updated_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to get session summary
CREATE OR REPLACE FUNCTION get_session_summary(p_session_id VARCHAR)
RETURNS TABLE (
    session_id VARCHAR,
    study_uid VARCHAR,
    creator VARCHAR,
    status VARCHAR,
    created_at TIMESTAMP,
    annotation_count BIGINT,
    participant_count BIGINT,
    active_participants BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.session_id,
        s.study_instance_uid,
        s.creator_id,
        s.status,
        s.created_at,
        COUNT(DISTINCT a.id) as annotation_count,
        COUNT(DISTINCT sp.user_id) as participant_count,
        COUNT(DISTINCT sp.user_id) FILTER (WHERE sp.left_at IS NULL) as active_participants
    FROM sessions s
    LEFT JOIN annotations a ON s.session_id = a.session_id
    LEFT JOIN session_participants sp ON s.session_id = sp.session_id
    WHERE s.session_id = p_session_id
    GROUP BY s.id, s.session_id, s.study_instance_uid, s.creator_id, s.status, s.created_at;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- GRANTS (for application user)
-- ============================================

-- Grant permissions to the application user
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO medical_imaging;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO medical_imaging;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medical_imaging;

-- ============================================
-- SCHEMA VERIFICATION
-- ============================================

-- Verify tables were created
DO $$
DECLARE
    table_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO table_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE';
    
    RAISE NOTICE 'Database schema initialized successfully!';
    RAISE NOTICE 'Tables created: %', table_count;
END $$;

-- Display table information
SELECT 
    table_name,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
AND table_type = 'BASE TABLE'
ORDER BY table_name;
