/**
 * CollaborationService.ts
 * 
 * Core service for real-time collaboration in OHIF Viewer.
 * Handles WebSocket connections, session management, and viewport synchronization.
 * 
 * Location: extensions/collaboration/src/services/CollaborationService.ts
 */

import { io, Socket } from 'socket.io-client';
import { throttle } from 'lodash';

// ============================================
// Type Definitions
// ============================================

export interface ViewportState {
  viewportId?: string;
  renderingEngineId?: string;
  type?: 'stack' | 'volume';
  camera?: {
    position: [number, number, number];
    focalPoint: [number, number, number];
    viewUp: [number, number, number];
    parallelScale?: number;
    viewAngle?: number;
  };
  zoom?: number;
  pan?: [number, number];
  voi?: {
    windowWidth: number;
    windowCenter: number;
  };
  imageIndex?: number;
  timestamp?: number;
}

export interface AnnotationData {
  annotationUID: string;
  data: any;
  metadata: any;
  frameOfReferenceUID?: string;
}

export interface SessionInfo {
  sessionId: string;
  studyInstanceUID: string;
  role: 'presenter' | 'follower';
  participants: Array<{
    userId: string;
    role: string;
    socketId: string;
  }>;
}

export interface CollaborationConfig {
  serverUrl: string;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  throttleMs?: number;
  connectionTimeout?: number;
}

// ============================================
// Collaboration Service
// ============================================

class CollaborationService {
  public static REGISTRATION = {
    name: 'collaborationService',
    create: ({ configuration = {} }) => {
      return new CollaborationService(configuration);
    },
  };

  public socket: Socket | null = null;
  private sessionId: string | null = null;
  private userId: string;
  private role: 'presenter' | 'follower' = 'follower';
  private isConnected: boolean = false;
  private isConnecting: boolean = false;
  private config: CollaborationConfig;
  private eventCallbacks: Map<string, Set<Function>> = new Map();
  private connectionPromise: Promise<void> | null = null;

  private throttledViewportBroadcast: ReturnType<typeof throttle>;

  constructor(config: Partial<CollaborationConfig> = {}) {
    this.config = {
      serverUrl: config.serverUrl || 'http://localhost:3001',
      reconnectionAttempts: config.reconnectionAttempts || 5,
      reconnectionDelay: config.reconnectionDelay || 1000,
      throttleMs: config.throttleMs || 100,
      connectionTimeout: config.connectionTimeout || 10000,
    };

    this.userId = this.generateUserId();

    this.throttledViewportBroadcast = throttle(
      this._broadcastViewportUpdate.bind(this),
      this.config.throttleMs,
      { leading: true, trailing: true }
    );
  }

  // ============================================
  // Connection Management
  // ============================================

  public connect(): Promise<void> {
    if (this.isConnected && this.socket?.connected) {
      return Promise.resolve();
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;

    this.connectionPromise = new Promise((resolve, reject) => {
      try {
        if (this.socket) {
          this.socket.removeAllListeners();
          this.socket.disconnect();
        }

        this.socket = io(this.config.serverUrl, {
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: this.config.reconnectionAttempts,
          reconnectionDelay: this.config.reconnectionDelay,
          timeout: this.config.connectionTimeout,
        });

        const timeoutId = setTimeout(() => {
          if (!this.isConnected) {
            this.isConnecting = false;
            this.connectionPromise = null;
            const error = new Error('Connection timeout');
            this.emit('connection:error', error);
            reject(error);
          }
        }, this.config.connectionTimeout);

        this.socket.on('connect', () => {
          clearTimeout(timeoutId);
          this.isConnected = true;
          this.isConnecting = false;
          this.emit('connection:established');
          resolve();
        });

        this.socket.on('connect_error', (error) => {
          clearTimeout(timeoutId);
          this.isConnected = false;
          this.isConnecting = false;
          this.connectionPromise = null;
          this.emit('connection:error', error);
          reject(error);
        });

        this.setupSocketListeners();

      } catch (error) {
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.connectionPromise = null;
    this.sessionId = null;
    this.role = 'follower';
    this.emit('connection:closed');
  }

  public isActive(): boolean {
    return this.isConnected && this.socket !== null && this.socket.connected;
  }

  // ============================================
  // Session Management
  // ============================================

  public async createSession(studyInstanceUID: string): Promise<string> {
    if (!this.isActive()) {
      await this.connect();
    }

    const response = await fetch(`${this.config.serverUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studyInstanceUID,
        userId: this.userId,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to create session: ${response.statusText}`);
    }

    const { sessionId } = await response.json();
    await this.joinSession(sessionId, 'presenter');
    return sessionId;
  }

  public async joinSession(
    sessionId: string,
    role: 'presenter' | 'follower' = 'follower'
  ): Promise<void> {
    if (!this.isActive()) {
      await this.connect();
    }

    if (!this.socket || !this.socket.connected) {
      throw new Error('Socket not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Join session timeout'));
      }, 10000);

      const handleSessionState = (state: any) => {
        clearTimeout(timeout);
        this.sessionId = sessionId;
        this.role = role;
        this.emit('session:joined', { sessionId, role });
        resolve();
      };

      this.once('session:state', handleSessionState);

      this.socket!.emit('session:join', {
        sessionId,
        userId: this.userId,
        role,
      });
    });
  }

  public async leaveSession(): Promise<void> {
    if (this.socket && this.sessionId) {
      this.socket.emit('session:leave', { sessionId: this.sessionId });
      this.emit('session:left', { sessionId: this.sessionId });
      this.sessionId = null;
      this.role = 'follower';
    }
  }

  public switchRole(newRole: 'presenter' | 'follower'): void {
    if (!this.socket || !this.sessionId) return;

    this.role = newRole;
    this.socket.emit('role:switch', { sessionId: this.sessionId, newRole });
    this.emit('role:changed', { role: newRole });
  }

  // ============================================
  // Viewport Synchronization
  // ============================================

  public broadcastViewportUpdate(viewportState: ViewportState): void {
    if (this.role !== 'presenter') return;
    if (!this.isActive()) return;
    if (!this.sessionId) return;

    this.throttledViewportBroadcast(viewportState);
  }

  private _broadcastViewportUpdate(viewportState: ViewportState): void {
    if (!this.socket || !this.sessionId) return;

    this.socket.emit('viewport:update', {
      sessionId: this.sessionId,
      viewportState,
    });
  }

  // ============================================
  // Annotation Synchronization
  // ============================================

  public broadcastAnnotationAdded(annotation: AnnotationData): void {
    if (!this.socket || !this.sessionId || !this.isActive()) return;

    this.socket.emit('annotation:add', {
      sessionId: this.sessionId,
      annotation,
    });
  }

  public broadcastAnnotationModified(annotationId: string, changes: Partial<AnnotationData>): void {
    if (!this.socket || !this.sessionId || !this.isActive()) return;

    this.socket.emit('annotation:modify', {
      sessionId: this.sessionId,
      annotationId,
      changes,
    });
  }

  public broadcastAnnotationDeleted(annotationId: string): void {
    if (!this.socket || !this.sessionId || !this.isActive()) return;

    this.socket.emit('annotation:delete', {
      sessionId: this.sessionId,
      annotationId,
    });
  }

  // ============================================
  // Socket Event Listeners
  // ============================================

  private setupSocketListeners(): void {
    if (!this.socket) return;

    // Session events
    this.socket.on('session:state', (state) => {
      this.emit('session:state', state);
    });

    this.socket.on('user:joined', (data) => {
      this.emit('user:joined', data);
    });

    this.socket.on('user:left', (data) => {
      this.emit('user:left', data);
    });

    // Viewport sync - server sends 'viewport:sync', we emit 'viewport:update' to local listeners
    this.socket.on('viewport:sync', (data) => {
      if (this.role === 'follower') {
        this.emit('viewport:update', data.viewportState);
      }
    });

    // Annotation events
    this.socket.on('annotation:added', (data) => {
      if (data.userId !== this.userId) {
        this.emit('annotation:added', data.annotation);
      }
    });

    this.socket.on('annotation:modified', (data) => {
      if (data.userId !== this.userId) {
        this.emit('annotation:modified', {
          annotationId: data.annotationId,
          changes: data.changes,
        });
      }
    });

    this.socket.on('annotation:deleted', (data) => {
      if (data.userId !== this.userId) {
        this.emit('annotation:deleted', { annotationId: data.annotationId });
      }
    });

    // Role events
    this.socket.on('role:changed', (data) => {
      this.emit('role:changed:remote', data);
    });

    // Connection events
    this.socket.on('disconnect', (reason) => {
      this.isConnected = false;
      this.emit('connection:closed', { reason });
    });

    this.socket.on('reconnect', (attemptNumber) => {
      this.isConnected = true;
      this.emit('connection:reconnected');
      
      if (this.sessionId) {
        this.joinSession(this.sessionId, this.role).catch(() => {});
      }
    });

    this.socket.on('error', (error) => {
      this.emit('server:error', error);
    });
  }

  // ============================================
  // Event Emitter
  // ============================================

  public on(event: string, callback: Function): void {
    if (!this.eventCallbacks.has(event)) {
      this.eventCallbacks.set(event, new Set());
    }
    this.eventCallbacks.get(event)!.add(callback);
  }

  public once(event: string, callback: Function): void {
    const wrappedCallback = (...args: any[]) => {
      callback(...args);
      this.off(event, wrappedCallback);
    };
    this.on(event, wrappedCallback);
  }

  public off(event: string, callback: Function): void {
    const callbacks = this.eventCallbacks.get(event);
    if (callbacks) {
      callbacks.delete(callback);
    }
  }

  private emit(event: string, data?: any): void {
    const callbacks = this.eventCallbacks.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event callback for ${event}:`, error);
        }
      });
    }
  }

  // ============================================
  // Utility Methods
  // ============================================

  private generateUserId(): string {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = localStorage.getItem('collaborationUserId');
      if (stored) return stored;
      const newId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('collaborationUserId', newId);
      return newId;
    }
    return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  public getUserId(): string {
    return this.userId;
  }

  public getRole(): 'presenter' | 'follower' {
    return this.role;
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public isPresenter(): boolean {
    return this.role === 'presenter';
  }

  public getConnectionStatus() {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
      serverUrl: this.config.serverUrl,
    };
  }

  public destroy(): void {
    this.throttledViewportBroadcast.cancel();
    this.disconnect();
    this.eventCallbacks.clear();
  }
}

export default CollaborationService;
