// ===========================================================
// C:\medical-imaging-platform\servers\collaboration\server.js
// ===========================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

// ============================================
// SERVER SETUP
// ============================================
const app = express();
const server = http.createServer(app);

// FIXED: Enhanced CORS configuration with all necessary origins
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');

const io = new Server(server, { 
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  // Add connection timeout settings
  pingTimeout: 60000,
  pingInterval: 25000,
  // Allow large payloads for segmentation data (50MB)
  maxHttpBufferSize: 50 * 1024 * 1024
});

// PostgreSQL connection pool with better error handling
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  database: process.env.POSTGRES_DB || 'annotations',
  user: process.env.POSTGRES_USER || 'medical_imaging',
  password: process.env.POSTGRES_PASSWORD || 'secure_password',
  port: parseInt(process.env.POSTGRES_PORT) || 5432,
  // Connection pool settings
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection with retry logic
const testDatabaseConnection = async (retries = 5) => {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await pool.query('SELECT NOW()');
      console.log('✅ Database connected successfully at', res.rows[0].now);
      return true;
    } catch (err) {
      console.error(`❌ Database connection attempt ${i + 1}/${retries} failed:`, err.message);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  console.error('❌ All database connection attempts failed');
  return false;
};

testDatabaseConnection();

// FIXED: Enhanced CORS middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With']
}));

app.use(express.json());

// Active collaboration sessions (in-memory tracking)
const activeSessions = new Map();

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================

io.on('connection', (socket) => {
  console.log(`🔗 Client connected: ${socket.id}`);

  // ==========================================
  // SESSION MANAGEMENT
  // ==========================================

  socket.on('session:join', async (data) => {
    try {
      const { sessionId, userId, role } = data;
      
      console.log(`👤 User ${userId} joining session ${sessionId} as ${role}`);

      // FIXED: Verify session exists in database before joining
      const sessionExists = await verifySessionExists(sessionId);
      if (!sessionExists) {
        socket.emit('error', { 
          message: 'Session not found', 
          code: 'SESSION_NOT_FOUND',
          sessionId 
        });
        return;
      }

      // Join Socket.IO room
      socket.join(sessionId);
      socket.userId = userId;
      socket.sessionId = sessionId;
      socket.role = role || 'follower';

      // Track session in memory
      if (!activeSessions.has(sessionId)) {
        activeSessions.set(sessionId, {
          id: sessionId,
          users: [],
          createdAt: new Date(),
        });
      }

      const session = activeSessions.get(sessionId);
      
      // Remove existing entry for this user if reconnecting
      session.users = session.users.filter(u => u.userId !== userId);
      
      session.users.push({ 
        socketId: socket.id, 
        userId, 
        role: socket.role 
      });

      // FIXED: Record participant with proper error handling
      try {
        await recordParticipant(sessionId, userId, socket.role);
      } catch (dbError) {
        console.error('⚠️ Failed to record participant in database:', dbError.message);
        // Continue anyway - participant is tracked in memory
      }

      // Notify other participants
      socket.to(sessionId).emit('user:joined', {
        userId,
        role: socket.role,
        timestamp: new Date().toISOString(),
      });

      // Send current session state to new user
      const sessionState = await loadSessionState(sessionId);
      socket.emit('session:state', sessionState);

      console.log(`✅ User ${userId} joined session ${sessionId} as ${socket.role}`);
      
      // Send success confirmation
      socket.emit('session:joined', {
        sessionId,
        role: socket.role,
        activeUsers: session.users.length
      });

    } catch (error) {
      console.error('❌ Error joining session:', error);
      socket.emit('error', { message: 'Failed to join session', error: error.message });
    }
  });

  // ==========================================
  // TEST: Simple ping to verify broadcasting works
  // ==========================================
  socket.on('test:ping', (data) => {
    console.log(`🏓 Received test:ping from ${socket.id}:`, data);
    
    // Get rooms this socket is in
    const rooms = Array.from(socket.rooms);
    console.log(`🏓 Socket ${socket.id} is in rooms:`, rooms);
    
    // Broadcast to all rooms except the socket's own room
    rooms.forEach(room => {
      if (room !== socket.id) {
        console.log(`🏓 Broadcasting test:pong to room ${room}`);
        socket.to(room).emit('test:pong', { 
          from: socket.id, 
          room,
          originalData: data,
          timestamp: Date.now() 
        });
        
        // Also try io.to for comparison
        io.to(room).emit('test:pong-io', { 
          from: socket.id, 
          room,
          originalData: data,
          timestamp: Date.now() 
        });
      }
    });
  });

  // ==========================================
  // VIEWPORT SYNCHRONIZATION
  // ==========================================

  // Presenter broadcasts viewport state to followers
  socket.on('viewport:update', (data) => {
    try {
      const { sessionId, viewportState } = data;
      
      // Only presenters can broadcast viewport updates
      if (socket.role !== 'presenter') {
        return;
      }

      // Debug logging
      const logState = viewportState?.type === 'volume' 
        ? `Z=${viewportState?.camera?.focalPoint?.[2]?.toFixed?.(1)}`
        : `index=${viewportState?.imageIndex}`;
      console.log(`🔄 Viewport update from ${socket.userId}: ${logState}`);

      // Broadcast to all other users in session
      socket.to(sessionId).emit('viewport:sync', {
        userId: socket.userId,
        viewportState,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      console.error('❌ Error updating viewport:', error);
    }
  });

  // ==========================================
  // VIEWPORT SYNC REQUEST (Follower → Presenter)
  // ==========================================
  // When a Follower finishes applying a segmentation, they request
  // the current viewport state from the Presenter to sync position.

  socket.on('request-viewport-sync', (data) => {
    try {
      const { sessionId } = data;
      
      console.log(`📥 Viewport sync requested by ${socket.userId} in session ${sessionId}`);
      
      // Debug: Check room membership
      const room = io.sockets.adapter.rooms.get(sessionId);
      const roomSize = room ? room.size : 0;
      console.log(`📥 Session ${sessionId} has ${roomSize} clients`);
      
      // Forward to all other users in session (presenter will respond)
      socket.to(sessionId).emit('request-viewport-sync', {
        requesterId: socket.userId,
        sessionId,
        timestamp: new Date().toISOString(),
      });
      
      console.log(`📤 Forwarded request-viewport-sync to session ${sessionId}`);
      
    } catch (error) {
      console.error('❌ Error forwarding viewport sync request:', error);
    }
  });

  // ==========================================
  // LEGACY VIEWPORT:SYNC HANDLER (for direct sync)
  // ==========================================
  // Some older code paths emit viewport:sync directly
  
  socket.on('viewport:sync', (data) => {
    try {
      const { sessionId, viewportState } = data;
      
      // Only presenters can broadcast
      if (socket.role !== 'presenter') {
        return;
      }

      // Forward to all other users
      socket.to(sessionId).emit('viewport:sync', {
        userId: socket.userId,
        viewportState,
        timestamp: new Date().toISOString(),
      });
      
    } catch (error) {
      console.error('❌ Error in viewport:sync:', error);
    }
  });
  
  // ==========================================
  // ANNOTATION EVENTS
  // ==========================================

  socket.on('annotation:add', async (data) => {
    try {
      const { sessionId, annotation } = data;
      
      // Handle both uid and annotationUID
      const annotationId = annotation?.uid || annotation?.annotationUID;
      console.log(`➕ Adding annotation ${annotationId} in session ${sessionId}`);
      console.log(`   Annotation keys:`, Object.keys(annotation || {}));

      // Broadcast to other users FIRST (before DB save which might fail)
      socket.to(sessionId).emit('annotation:added', {
        userId: socket.userId,
        annotation,
        timestamp: new Date().toISOString(),
      });
      console.log(`📤 Broadcast annotation:added to session ${sessionId}`);

      // Save to database (non-blocking for sync)
      try {
        await saveAnnotation(sessionId, annotation, socket.userId);
      } catch (dbError) {
        console.error('⚠️ Database save failed (sync still works):', dbError.message);
      }

      // Send confirmation to sender
      socket.emit('annotation:saved', {
        annotationUID: annotationId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error adding annotation:', error);
      socket.emit('error', { message: 'Failed to save annotation', error: error.message });
    }
  });

  socket.on('annotation:modify', async (data) => {
    try {
      const { sessionId, annotationId, changes } = data;
      
      console.log(`✏️ Modifying annotation ${annotationId} in session ${sessionId}`);

      // Update in database
      await updateAnnotation(annotationId, changes, socket.userId);

      // Broadcast to other users
      socket.to(sessionId).emit('annotation:modified', {
        userId: socket.userId,
        annotationId,
        changes,
        timestamp: new Date().toISOString(),
      });

      // Send confirmation
      socket.emit('annotation:updated', {
        annotationId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error modifying annotation:', error);
      socket.emit('error', { message: 'Failed to update annotation', error: error.message });
    }
  });

  socket.on('annotation:delete', async (data) => {
    try {
      const { sessionId, annotationId } = data;
      
      console.log(`🗑️ Deleting annotation ${annotationId} in session ${sessionId}`);

      // Delete from database
      await deleteAnnotation(annotationId);

      // Broadcast to other users
      socket.to(sessionId).emit('annotation:deleted', {
        userId: socket.userId,
        annotationId,
        timestamp: new Date().toISOString(),
      });

      // Send confirmation
      socket.emit('annotation:removed', {
        annotationId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error deleting annotation:', error);
      socket.emit('error', { message: 'Failed to delete annotation', error: error.message });
    }
  });

  // ==========================================
  // SEGMENTATION SYNCHRONIZATION
  // ==========================================

  // Segmentation added
  socket.on('segmentation:add', async (data) => {
    try {
      const { sessionId, segmentation } = data;
      
      if (!sessionId || !segmentation) {
        socket.emit('error', { message: 'Invalid segmentation data' });
        return;
      }

      console.log(`📊 Segmentation added in session ${sessionId}: ${segmentation.segmentationId}`);
      console.log(`📊 Has labelmap data: ${!!segmentation.labelmapData}`);
      
      // Debug: Check room membership
      const room = io.sockets.adapter.rooms.get(sessionId);
      const roomSize = room ? room.size : 0;
      console.log(`📊 Session room ${sessionId} has ${roomSize} clients`);
      console.log(`📊 Room members:`, room ? Array.from(room) : []);
      console.log(`📊 Sender socket ID: ${socket.id}`);

      // Debug: Try broadcasting a simple test event first
      socket.to(sessionId).emit('test:broadcast', { msg: 'test from server' });
      console.log(`📤 Test broadcast sent to room ${sessionId}`);

      // Debug: Try using io.to() instead of socket.to()
      io.to(sessionId).emit('segmentation:added', {
        userId: socket.userId,
        segmentation,
        timestamp: new Date().toISOString(),
      });
      
      console.log(`📤 Emitted segmentation:added via io.to() to room ${sessionId}`);

      // Optionally store segmentation metadata in database (NOT the full volume data)
      try {
        await pool.query(
          `INSERT INTO segmentations (session_id, segmentation_id, label, segment_count, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (session_id, segmentation_id) 
           DO UPDATE SET label = $3, segment_count = $4, updated_at = NOW()`,
          [sessionId, segmentation.segmentationId, segmentation.label, segmentation.segments?.length || 0, socket.userId]
        );
      } catch (dbError) {
        // Non-fatal - table might not exist yet
        console.log('⚠️ Could not store segmentation metadata (table may not exist):', dbError.message);
      }

      console.log(`✅ Segmentation broadcast to session ${sessionId}`);
    } catch (error) {
      console.error('❌ Error adding segmentation:', error);
      socket.emit('error', { message: 'Failed to add segmentation', error: error.message });
    }
  });

  // Segmentation updated
  socket.on('segmentation:update', async (data) => {
    try {
      const { sessionId, segmentation } = data;
      
      if (!sessionId || !segmentation) {
        socket.emit('error', { message: 'Invalid segmentation update' });
        return;
      }

      console.log(`🔄 Segmentation updated in session ${sessionId}: ${segmentation.segmentationId}`);

      // Broadcast to all other users in the session
      socket.to(sessionId).emit('segmentation:updated', {
        userId: socket.userId,
        segmentation,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      console.error('❌ Error updating segmentation:', error);
      socket.emit('error', { message: 'Failed to update segmentation', error: error.message });
    }
  });

  // Segmentation removed
  socket.on('segmentation:remove', async (data) => {
    try {
      const { sessionId, segmentationId } = data;
      
      if (!sessionId || !segmentationId) {
        socket.emit('error', { message: 'Invalid segmentation removal' });
        return;
      }

      console.log(`🗑️ Segmentation removed in session ${sessionId}: ${segmentationId}`);

      // Broadcast to all other users in the session
      socket.to(sessionId).emit('segmentation:removed', {
        userId: socket.userId,
        segmentationId,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      console.error('❌ Error removing segmentation:', error);
      socket.emit('error', { message: 'Failed to remove segmentation', error: error.message });
    }
  });

  // ==========================================
  // ROLE SWITCHING
  // ==========================================

  socket.on('role:switch', (data) => {
    try {
      const { sessionId, newRole } = data;
      
      console.log(`🔄 User ${socket.userId} switching role to ${newRole} in session ${sessionId}`);
      
      socket.role = newRole;

      // Update in session tracking
      const session = activeSessions.get(sessionId);
      if (session) {
        const user = session.users.find(u => u.socketId === socket.id);
        if (user) {
          user.role = newRole;
        }
      }

      // Broadcast role change
      socket.to(sessionId).emit('role:changed', {
        userId: socket.userId,
        newRole,
        timestamp: new Date().toISOString(),
      });

      // Confirm to sender
      socket.emit('role:switched', {
        newRole,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error switching role:', error);
      socket.emit('error', { message: 'Failed to switch role', error: error.message });
    }
  });

  // ==========================================
  // SESSION LEAVE (explicit)
  // ==========================================

  socket.on('session:leave', async (data) => {
    try {
      const sessionId = data?.sessionId || socket.sessionId;
      const userId = socket.userId;

      console.log(`👋 User ${userId} leaving session ${sessionId}`);

      await handleUserLeave(socket, sessionId, userId);

      socket.emit('session:left', {
        sessionId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error leaving session:', error);
    }
  });

  // ==========================================
  // DISCONNECT HANDLING
  // ==========================================

  socket.on('disconnect', async (reason) => {
    try {
      const sessionId = socket.sessionId;
      const userId = socket.userId;

      console.log(`🔌 Client disconnected: ${socket.id}, reason: ${reason}`);

      if (sessionId && userId) {
        await handleUserLeave(socket, sessionId, userId);
      }
    } catch (error) {
      console.error('❌ Error handling disconnect:', error);
    }
  });

  // ==========================================
  // ERROR HANDLING
  // ==========================================

  socket.on('error', (error) => {
    console.error('❌ Socket error:', error);
  });
});

// ============================================
// HELPER FUNCTION: Handle user leaving
// ============================================

async function handleUserLeave(socket, sessionId, userId) {
  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    
    // Remove user from session
    session.users = session.users.filter(u => u.socketId !== socket.id);

    // Update database
    try {
      await recordParticipantLeft(sessionId, userId);
    } catch (dbError) {
      console.error('⚠️ Failed to record participant leave:', dbError.message);
    }

    // Notify remaining users
    socket.to(sessionId).emit('user:left', {
      userId,
      timestamp: new Date().toISOString(),
    });

    // Clean up empty sessions
    if (session.users.length === 0) {
      console.log(`🧹 Cleaning up empty session: ${sessionId}`);
      activeSessions.delete(sessionId);
    }
  }

  // Clear socket session data
  socket.sessionId = null;
  socket.userId = null;
  socket.role = null;
}

// ============================================
// DATABASE FUNCTIONS
// ============================================

// FIXED: Added function to verify session exists
async function verifySessionExists(sessionId) {
  const query = `SELECT 1 FROM sessions WHERE session_id = $1 AND status = 'active'`;
  
  try {
    const result = await pool.query(query, [sessionId]);
    return result.rows.length > 0;
  } catch (error) {
    console.error('❌ Database error verifying session:', error);
    return false;
  }
}

async function saveAnnotation(sessionId, annotation, createdBy) {
  const query = `
    INSERT INTO annotations (session_id, annotation_id, data, created_by, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (annotation_id) 
    DO UPDATE SET 
      data = EXCLUDED.data,
      updated_by = $4,
      updated_at = NOW()
    RETURNING id
  `;
  
  try {
    const result = await pool.query(query, [
      sessionId,
      (annotation.uid || annotation.annotationUID),
      JSON.stringify(annotation),
      createdBy
    ]);
    return result.rows[0].id;
  } catch (error) {
    console.error('❌ Database error saving annotation:', error);
    throw error;
  }
}

// FIXED: Corrected query to match actual database schema
async function updateAnnotation(annotationId, changes, updatedBy) {
  const query = `
    UPDATE annotations
    SET data = data || $1::jsonb, 
        updated_at = NOW(),
        updated_by = $3
    WHERE annotation_id = $2
    RETURNING id
  `;
  
  try {
    const result = await pool.query(query, [
      JSON.stringify(changes),
      annotationId,
      updatedBy
    ]);
    
    if (result.rows.length === 0) {
      console.warn(`⚠️ Annotation ${annotationId} not found for update`);
      return null;
    }
    
    return result.rows[0];
  } catch (error) {
    console.error('❌ Database error updating annotation:', error);
    throw error;
  }
}

async function deleteAnnotation(annotationId) {
  const query = `DELETE FROM annotations WHERE annotation_id = $1 RETURNING id`;
  
  try {
    const result = await pool.query(query, [annotationId]);
    if (result.rows.length === 0) {
      console.warn(`⚠️ Annotation ${annotationId} not found for deletion`);
    }
    return result.rows.length > 0;
  } catch (error) {
    console.error('❌ Database error deleting annotation:', error);
    throw error;
  }
}

async function loadSessionState(sessionId) {
  const query = `
    SELECT annotation_id, data, created_by, created_at
    FROM annotations
    WHERE session_id = $1
    ORDER BY created_at ASC
  `;
  
  try {
    const result = await pool.query(query, [sessionId]);
    return {
      annotations: result.rows.map(row => row.data),
      sessionId,
      loadedAt: new Date().toISOString(),
      annotationCount: result.rows.length
    };
  } catch (error) {
    console.error('❌ Database error loading session state:', error);
    return { annotations: [], sessionId, loadedAt: new Date().toISOString() };
  }
}

// FIXED: Proper error handling instead of silent failure
async function recordParticipant(sessionId, userId, role) {
  const query = `
    INSERT INTO session_participants (session_id, user_id, role, joined_at)
    VALUES ($1, $2, $3, NOW())
    RETURNING id
  `;
  
  try {
    const result = await pool.query(query, [sessionId, userId, role]);
    console.log(`✅ Participant recorded: ${userId} in session ${sessionId}`);
    return result.rows[0];
  } catch (error) {
    // Handle unique constraint violation (user rejoining)
    if (error.code === '23505') {
      console.log(`ℹ️ Participant ${userId} already in session ${sessionId}`);
      return null;
    }
    console.error('❌ Database error recording participant:', error);
    throw error;
  }
}

async function recordParticipantLeft(sessionId, userId) {
  const query = `
    UPDATE session_participants
    SET left_at = NOW()
    WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL
    RETURNING id
  `;
  
  try {
    const result = await pool.query(query, [sessionId, userId]);
    if (result.rows.length > 0) {
      console.log(`✅ Participant ${userId} marked as left session ${sessionId}`);
    }
    return result.rows.length > 0;
  } catch (error) {
    console.error('❌ Database error recording participant left:', error);
    throw error;
  }
}

// ============================================
// REST API ENDPOINTS
// ============================================

// Health check
app.get('/health', async (req, res) => {
  let dbStatus = 'unknown';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'healthy';
  } catch (error) {
    dbStatus = 'unhealthy';
  }

  res.json({ 
    status: 'healthy', 
    database: dbStatus,
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    activeConnections: io.engine.clientsCount
  });
});

// Create new session
app.post('/api/sessions', async (req, res) => {
  try {
    const { studyInstanceUID, userId } = req.body;

    if (!studyInstanceUID || !userId) {
      return res.status(400).json({ error: 'Missing required fields: studyInstanceUID and userId' });
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create session in database
    const query = `
      INSERT INTO sessions (session_id, study_instance_uid, creator_id, status, created_at)
      VALUES ($1, $2, $3, 'active', NOW())
      RETURNING session_id, created_at
    `;

    const result = await pool.query(query, [sessionId, studyInstanceUID, userId]);

    console.log(`✅ Session created: ${sessionId} by user ${userId}`);

    res.json({ 
      sessionId: result.rows[0].session_id,
      studyInstanceUID,
      createdAt: result.rows[0].created_at
    });

  } catch (error) {
    console.error('❌ Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session', message: error.message });
  }
});

// Get session details
app.get('/api/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const query = `
      SELECT 
        s.*,
        COALESCE(
          json_agg(
            json_build_object(
              'annotationId', a.annotation_id,
              'data', a.data,
              'createdBy', a.created_by,
              'createdAt', a.created_at
            )
          ) FILTER (WHERE a.id IS NOT NULL),
          '[]'
        ) as annotations
      FROM sessions s
      LEFT JOIN annotations a ON s.session_id = a.session_id
      WHERE s.session_id = $1
      GROUP BY s.id
    `;

    const result = await pool.query(query, [sessionId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Add active users from memory
    const session = activeSessions.get(sessionId);
    const response = {
      ...result.rows[0],
      activeUsers: session ? session.users : []
    };

    res.json(response);

  } catch (error) {
    console.error('❌ Error fetching session:', error);
    res.status(500).json({ error: 'Failed to fetch session', message: error.message });
  }
});

// Get active sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const query = `
      SELECT 
        s.session_id,
        s.study_instance_uid,
        s.creator_id,
        s.created_at,
        s.status,
        COUNT(DISTINCT a.id) as annotation_count,
        COUNT(DISTINCT sp.user_id) FILTER (WHERE sp.left_at IS NULL) as active_users
      FROM sessions s
      LEFT JOIN annotations a ON s.session_id = a.session_id
      LEFT JOIN session_participants sp ON s.session_id = sp.session_id
      WHERE s.status = 'active'
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT 50
    `;

    const result = await pool.query(query);
    res.json(result.rows);

  } catch (error) {
    console.error('❌ Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions', message: error.message });
  }
});

// Close session
app.post('/api/sessions/:sessionId/close', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const query = `
      UPDATE sessions
      SET status = 'closed', updated_at = NOW()
      WHERE session_id = $1
      RETURNING session_id
    `;

    const result = await pool.query(query, [sessionId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Notify all users in session
    io.to(sessionId).emit('session:closed', {
      sessionId,
      closedAt: new Date().toISOString()
    });

    // Remove from active sessions
    activeSessions.delete(sessionId);

    console.log(`✅ Session closed: ${sessionId}`);

    res.json({ 
      sessionId, 
      status: 'closed',
      closedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error closing session:', error);
    res.status(500).json({ error: 'Failed to close session', message: error.message });
  }
});

// ============================================
// SERVER STARTUP
// ============================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║   🏥 Medical Imaging Collaboration Server                 ║
║   🚀 Server running on port ${PORT}                          ║
║   📡 WebSocket server ready                               ║
║   💾 Database connection initialized                      ║
║   🔧 CORS Origins: ${allowedOrigins.join(', ')}
║   ✅ Ready to accept connections                          ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`⚠️  ${signal} received, shutting down gracefully...`);
  
  // Close Socket.IO connections
  io.close(() => {
    console.log('✅ Socket.IO server closed');
  });
  
  // Close HTTP server
  server.close(() => {
    console.log('✅ HTTP server closed');
    
    // Close database pool
    pool.end(() => {
      console.log('✅ Database pool closed');
      process.exit(0);
    });
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('❌ Forced exit after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

