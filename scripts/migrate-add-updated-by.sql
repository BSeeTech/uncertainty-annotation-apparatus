-- Medical Imaging Platform - Database Migration
-- File: migrate-add-updated-by.sql
-- Purpose: Add missing 'updated_by' column to annotations table
-- Run this script if you already have an existing database
--
-- Usage: 
--   docker exec -i medical-postgres psql -U medical_imaging -d annotations < migrate-add-updated-by.sql
-- Or:
--   psql -U medical_imaging -d annotations -f migrate-add-updated-by.sql

-- ============================================
-- Check and add updated_by column if missing
-- ============================================

DO $$
BEGIN
    -- Check if column already exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'annotations' 
        AND column_name = 'updated_by'
    ) THEN
        -- Add the column
        ALTER TABLE annotations ADD COLUMN updated_by VARCHAR(255);
        RAISE NOTICE 'SUCCESS: Added updated_by column to annotations table';
        
        -- Create index for performance
        CREATE INDEX IF NOT EXISTS idx_annotations_updated_by ON annotations(updated_by);
        RAISE NOTICE 'SUCCESS: Created index on updated_by column';
    ELSE
        RAISE NOTICE 'SKIP: updated_by column already exists';
    END IF;
END $$;

-- ============================================
-- Add unique constraint to session_participants
-- if not exists (for preventing duplicate active participants)
-- ============================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'unique_active_participant'
    ) THEN
        -- This may fail if there are existing duplicates, so we handle it
        BEGIN
            ALTER TABLE session_participants 
            ADD CONSTRAINT unique_active_participant 
            UNIQUE (session_id, user_id, joined_at);
            RAISE NOTICE 'SUCCESS: Added unique_active_participant constraint';
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'WARNING: Could not add unique constraint - may have duplicate data. Error: %', SQLERRM;
        END;
    ELSE
        RAISE NOTICE 'SKIP: unique_active_participant constraint already exists';
    END IF;
END $$;

-- ============================================
-- Add index for active participants
-- ============================================

CREATE INDEX IF NOT EXISTS idx_participants_active 
ON session_participants(session_id) 
WHERE left_at IS NULL;

-- ============================================
-- Summary
-- ============================================

DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Migration complete!';
    RAISE NOTICE 'Please restart the collaboration server';
    RAISE NOTICE '========================================';
END $$;
