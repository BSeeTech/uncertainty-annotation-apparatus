# ========================================
# Connect to database interactively
# ========================================
docker exec -it medical-postgres psql -U medical_imaging -d annotations

# ========================================
# Run single query
# ========================================
docker exec medical-postgres psql -U medical_imaging -d annotations -c "SELECT * FROM sessions;"

# ========================================
# View tables
# ========================================
docker exec medical-postgres psql -U medical_imaging -d annotations -c "\dt"

# ========================================
# View table structure
# ========================================
docker exec medical-postgres psql -U medical_imaging -d annotations -c "\d sessions"

# ========================================
# Count records
# ========================================
docker exec medical-postgres psql -U medical_imaging -d annotations -c "SELECT COUNT(*) FROM sessions;"

# ========================================
# View all data in sessions table
# ========================================
docker exec medical-postgres psql -U medical_imaging -d annotations -c "SELECT * FROM sessions;"

# ========================================
# Check database size
# ========================================
docker exec medical-postgres psql -U medical_imaging -d annotations -c "SELECT pg_size_pretty(pg_database_size('annotations'));"