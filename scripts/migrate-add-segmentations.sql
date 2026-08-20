-- Migration: Add segmentations table for collaboration
-- Run this after init-db.sql
-- File: scripts/migrate-add-segmentations.sql

-- Create segmentations table
CREATE TABLE IF NOT EXISTS segmentations (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    segmentation_id VARCHAR(255) NOT NULL,
    label VARCHAR(255),
    description TEXT,
    segment_count INTEGER DEFAULT 0,
    
    -- Reference to source data (DICOM SEG, etc.)
    dicom_seg_sop_instance_uid VARCHAR(255),
    referenced_series_uid VARCHAR(255),
    
    -- Metadata
    segmentation_type VARCHAR(50) DEFAULT 'LABELMAP', -- LABELMAP or CONTOUR
    
    -- Tracking
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(session_id, segmentation_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_segmentations_session ON segmentations(session_id);
CREATE INDEX IF NOT EXISTS idx_segmentations_dicom_seg ON segmentations(dicom_seg_sop_instance_uid);

-- Create segments table (individual segments within a segmentation)
CREATE TABLE IF NOT EXISTS segments (
    id SERIAL PRIMARY KEY,
    segmentation_id VARCHAR(255) NOT NULL,
    session_id VARCHAR(255) NOT NULL,
    segment_index INTEGER NOT NULL,
    label VARCHAR(255),
    color_r INTEGER DEFAULT 255,
    color_g INTEGER DEFAULT 0,
    color_b INTEGER DEFAULT 0,
    color_a INTEGER DEFAULT 255,
    is_visible BOOLEAN DEFAULT TRUE,
    is_locked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(session_id, segmentation_id, segment_index),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_segments_segmentation ON segments(session_id, segmentation_id);

-- Function to update timestamp on modification
CREATE OR REPLACE FUNCTION update_segmentation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for auto-updating timestamps
DROP TRIGGER IF EXISTS segmentations_updated_at ON segmentations;
CREATE TRIGGER segmentations_updated_at
    BEFORE UPDATE ON segmentations
    FOR EACH ROW
    EXECUTE FUNCTION update_segmentation_timestamp();

DROP TRIGGER IF EXISTS segments_updated_at ON segments;
CREATE TRIGGER segments_updated_at
    BEFORE UPDATE ON segments
    FOR EACH ROW
    EXECUTE FUNCTION update_segmentation_timestamp();

-- Add comments
COMMENT ON TABLE segmentations IS 'Stores segmentation metadata for collaboration sessions';
COMMENT ON TABLE segments IS 'Stores individual segment properties within segmentations';
COMMENT ON COLUMN segmentations.dicom_seg_sop_instance_uid IS 'Reference to DICOM SEG object in Orthanc';
COMMENT ON COLUMN segmentations.segmentation_type IS 'LABELMAP (volume mask) or CONTOUR (polylines)';
