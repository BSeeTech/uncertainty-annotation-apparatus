import React, { useState, useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { Button, Input, Typography } from '@ohif/ui';
import { useAnnotationSync } from '../hooks/useAnnotationSync';
import { useSegmentationSync } from '../hooks/useSegmentationSync';

/**
 * CollaborationPanel - Real-time viewport and annotation synchronization
 * 
 * Enables multiple users to collaborate on viewing medical images.
 * - Presenter: Their viewport changes are broadcast to all followers
 * - Follower: Their viewport automatically syncs with the presenter
 * - Annotations: All participants can create, modify, and delete annotations
 * - Segmentations: MONAI Label DeepEdit and other segmentation tools sync in real-time
 */

const CollaborationPanel = ({ servicesManager, commandsManager }) => {
  const { collaborationService, viewportGridService, displaySetService } = servicesManager?.services || {};

  // State
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [role, setRole] = useState<'presenter' | 'follower'>('follower');
  const [participants, setParticipants] = useState<any[]>([]);
  const [joinSessionInput, setJoinSessionInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [studyChangeNotification, setStudyChangeNotification] = useState<string | null>(null);
  const [annotationSyncEnabled, setAnnotationSyncEnabled] = useState(true);
  const [segmentationSyncEnabled, setSegmentationSyncEnabled] = useState(true);

  // Refs for event handlers
  const roleRef = useRef(role);
  const sessionIdRef = useRef(sessionId);
  const setupDoneRef = useRef(false);
  const lastBroadcastIndexRef = useRef(-1);
  const currentStudyUIDRef = useRef<string | null>(null);

  useEffect(() => { roleRef.current = role; }, [role]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // Annotation sync hook
  useAnnotationSync({
    collaborationService,
    servicesManager,
    isEnabled: annotationSyncEnabled && isConnected && !!sessionId,
    role,
    sessionId,
  });

  // Segmentation sync hook (for MONAI Label DeepEdit, etc.)
  useSegmentationSync({
    collaborationService,
    servicesManager,
    isEnabled: segmentationSyncEnabled && isConnected && !!sessionId,
    role,
    sessionId,
  });

  // Get current study UID
  const getCurrentStudyUID = (): string | null => {
    try {
      const activeViewportId = viewportGridService?.getActiveViewportId?.();
      const viewportState = viewportGridService?.getState?.();
      const vp = viewportState?.viewports?.get(activeViewportId);
      if (!vp?.displaySetInstanceUIDs?.length) return null;
      const displaySet = displaySetService?.getDisplaySetByUID(vp.displaySetInstanceUIDs[0]);
      return displaySet?.StudyInstanceUID || null;
    } catch {
      return null;
    }
  };

  // ============================================
  // VIEWPORT UTILITIES
  // ============================================

  const getSocket = () => (collaborationService as any)?.socket;

  const getViewport = () => {
    try {
      const cs = (window as any).cornerstone;
      if (!cs?.getRenderingEngines) return null;
      const engines = cs.getRenderingEngines();
      for (const engine of engines) {
        const viewports = engine.getViewports();
        for (const vp of viewports) {
          if (vp.type === 'stack') return vp;
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  const getCurrentImageIndex = (): number => {
    const vp = getViewport();
    return vp?.getCurrentImageIdIndex?.() ?? -1;
  };

  const getStackSize = (): number => {
    const vp = getViewport();
    return vp?.getImageIds?.()?.length ?? 0;
  };

  const scrollToImage = (index: number) => {
    const vp = getViewport();
    if (!vp) return;
    const stackSize = vp.getImageIds?.()?.length ?? 0;
    if (stackSize === 0) return;
    const safeIndex = Math.max(0, Math.min(index, stackSize - 1));
    const currentIndex = vp.getCurrentImageIdIndex?.() ?? -1;
    if (currentIndex !== safeIndex) {
      vp.setImageIdIndex(safeIndex);
      vp.render();
    }
  };

  // Handle viewport update including study changes
  const handleViewportUpdate = (state: any) => {
    if (roleRef.current !== 'follower') return;
    
    // Check if presenter changed studies
    if (state?.studyChanged && state?.studyInstanceUID) {
      const currentStudy = getCurrentStudyUID();
      if (currentStudy !== state.studyInstanceUID) {
        // Notify follower that presenter changed studies
        setStudyChangeNotification(state.studyInstanceUID);
        return;
      }
    }
    
    const vp = getViewport();
    if (!vp) return;
    
    const stackSize = vp.getImageIds?.()?.length ?? 0;
    if (stackSize === 0) return;
    
    let needsRender = false;
    
    // Apply image index (scroll)
    if (state?.imageIndex !== undefined) {
      const safeIndex = Math.max(0, Math.min(state.imageIndex, stackSize - 1));
      const currentIndex = vp.getCurrentImageIdIndex?.() ?? -1;
      if (currentIndex !== safeIndex) {
        vp.setImageIdIndex(safeIndex);
        needsRender = true;
      }
    }
    
    // Apply zoom
    if (state?.zoom !== undefined && state.zoom > 0) {
      const currentZoom = vp.getZoom?.() ?? 1;
      if (Math.abs(currentZoom - state.zoom) > 0.01) {
        vp.setZoom(state.zoom);
        needsRender = true;
      }
    }
    
    // Apply pan
    if (state?.pan && Array.isArray(state.pan) && state.pan.length === 2) {
      const currentPan = vp.getPan?.() ?? [0, 0];
      if (Math.abs(currentPan[0] - state.pan[0]) > 1 || Math.abs(currentPan[1] - state.pan[1]) > 1) {
        vp.setPan(state.pan);
        needsRender = true;
      }
    }
    
    // Apply VOI (window/level)
    if (state?.voi && state.voi.windowWidth > 0) {
      try {
        const lower = state.voi.windowCenter - state.voi.windowWidth / 2;
        const upper = state.voi.windowCenter + state.voi.windowWidth / 2;
        vp.setProperties?.({ voiRange: { lower, upper } });
        needsRender = true;
      } catch (e) {}
    }
    
    // Apply rotation
    if (state?.rotation !== undefined) {
      try {
        const currentRotation = vp.getRotation?.() ?? 0;
        if (Math.abs(currentRotation - state.rotation) > 0.5) {
          vp.setRotation?.(state.rotation);
          needsRender = true;
        }
      } catch (e) {}
    }
    
    // Apply flip horizontal
    if (state?.flipHorizontal !== undefined) {
      try {
        const props = vp.getProperties?.() || {};
        if (props.flipHorizontal !== state.flipHorizontal) {
          vp.setProperties?.({ flipHorizontal: state.flipHorizontal });
          needsRender = true;
        }
      } catch (e) {
        // Try alternative method using camera
        try {
          const camera = vp.getCamera?.();
          if (camera && camera.flipHorizontal !== state.flipHorizontal) {
            vp.setCamera?.({ ...camera, flipHorizontal: state.flipHorizontal });
            needsRender = true;
          }
        } catch (e2) {}
      }
    }
    
    // Apply flip vertical
    if (state?.flipVertical !== undefined) {
      try {
        const props = vp.getProperties?.() || {};
        if (props.flipVertical !== state.flipVertical) {
          vp.setProperties?.({ flipVertical: state.flipVertical });
          needsRender = true;
        }
      } catch (e) {
        // Try alternative method using camera
        try {
          const camera = vp.getCamera?.();
          if (camera && camera.flipVertical !== state.flipVertical) {
            vp.setCamera?.({ ...camera, flipVertical: state.flipVertical });
            needsRender = true;
          }
        } catch (e2) {}
      }
    }
    
    // Apply invert
    if (state?.invert !== undefined) {
      try {
        const props = vp.getProperties?.() || {};
        if (props.invert !== state.invert) {
          vp.setProperties?.({ invert: state.invert });
          needsRender = true;
        }
      } catch (e) {}
    }
    
    if (needsRender) {
      vp.render();
    }
  };

  // Navigate to a study (for followers to follow presenter's study change)
  const navigateToStudy = (studyInstanceUID: string) => {
    // Close notification
    setStudyChangeNotification(null);
    
    // Navigate to the study URL
    // OHIF typically uses: /viewer?StudyInstanceUIDs=<uid>
    const currentUrl = new URL(window.location.href);
    const baseUrl = currentUrl.origin + currentUrl.pathname;
    const newUrl = `${baseUrl}?StudyInstanceUIDs=${studyInstanceUID}`;
    window.location.href = newUrl;
  };

  // ============================================
  // AUTO-BROADCAST FOR PRESENTER
  // ============================================

  useEffect(() => {
    if (!sessionId || role !== 'presenter') {
      setupDoneRef.current = false;
      return;
    }
    if (setupDoneRef.current) return;
    setupDoneRef.current = true;

    let pollTimer: any = null;

    // Check for study changes
    const checkStudyChange = () => {
      const currentStudy = getCurrentStudyUID();
      if (currentStudy && currentStudy !== currentStudyUIDRef.current) {
        currentStudyUIDRef.current = currentStudy;
        // Broadcast study change to followers
        const socket = getSocket();
        const sid = sessionIdRef.current;
        if (socket?.connected && sid) {
          socket.emit('viewport:update', {
            sessionId: sid,
            viewportState: { 
              imageIndex: getCurrentImageIndex(),
              studyInstanceUID: currentStudy,
              studyChanged: true,
            },
          });
        }
      }
    };
    
    // Track last broadcast state to detect changes
    let lastState = { 
      imageIndex: -1, 
      zoom: 1, 
      panX: 0, 
      panY: 0, 
      ww: 0, 
      wc: 0,
      rotation: 0,
      flipH: false,
      flipV: false,
      invert: false,
    };
    
    const captureCurrentState = () => {
      const vp = getViewport();
      if (!vp) return null;
      
      const imageIndex = vp.getCurrentImageIdIndex?.() ?? -1;
      const zoom = vp.getZoom?.() ?? 1;
      const pan = vp.getPan?.() ?? [0, 0];
      
      // Get properties including VOI, rotation, flip, invert
      let ww = 0, wc = 0, invert = false;
      try {
        const properties = vp.getProperties?.() || {};
        if (properties.voiRange) {
          ww = properties.voiRange.upper - properties.voiRange.lower;
          wc = properties.voiRange.lower + ww / 2;
        }
        invert = properties.invert ?? false;
      } catch (e) {}
      
      // Get rotation from camera
      let rotation = 0;
      try {
        rotation = vp.getRotation?.() ?? 0;
      } catch (e) {}
      
      // Get flip state
      let flipH = false, flipV = false;
      try {
        const camera = vp.getCamera?.();
        if (camera) {
          // Flip is determined by the camera's flipHorizontal and flipVertical
          // or by checking viewUp and viewPlaneNormal
          flipH = camera.flipHorizontal ?? false;
          flipV = camera.flipVertical ?? false;
        }
        // Alternative: check viewport properties
        const props = vp.getProperties?.() || {};
        if (props.flipHorizontal !== undefined) flipH = props.flipHorizontal;
        if (props.flipVertical !== undefined) flipV = props.flipVertical;
      } catch (e) {}
      
      return { 
        imageIndex, 
        zoom, 
        panX: pan[0], 
        panY: pan[1], 
        ww, 
        wc,
        rotation,
        flipH,
        flipV,
        invert,
      };
    };
    
    const hasStateChanged = (current: any) => {
      if (!current) return false;
      
      const changed = (
        current.imageIndex !== lastState.imageIndex ||
        Math.abs(current.zoom - lastState.zoom) > 0.01 ||
        Math.abs(current.panX - lastState.panX) > 1 ||
        Math.abs(current.panY - lastState.panY) > 1 ||
        Math.abs(current.ww - lastState.ww) > 1 ||
        Math.abs(current.wc - lastState.wc) > 1 ||
        Math.abs(current.rotation - lastState.rotation) > 0.5 ||
        current.flipH !== lastState.flipH ||
        current.flipV !== lastState.flipV ||
        current.invert !== lastState.invert
      );
      
      return changed;
    };
    
    const broadcastIfChanged = () => {
      const current = captureCurrentState();
      if (!current || current.imageIndex < 0) return;
      
      if (!hasStateChanged(current)) return;
      
      // Update last state
      lastState = { ...current };
      
      const socket = getSocket();
      const sid = sessionIdRef.current;
      if (!socket?.connected || !sid) return;

      const studyUID = getCurrentStudyUID();
      
      // Build VOI object
      let voi = null;
      if (current.ww > 0) {
        voi = { windowWidth: current.ww, windowCenter: current.wc };
      }

      console.log('[Collab] Broadcasting:', {
        img: current.imageIndex,
        zoom: current.zoom.toFixed(2),
        pan: [current.panX.toFixed(0), current.panY.toFixed(0)],
        ww: current.ww.toFixed(0),
        rotation: current.rotation.toFixed(0),
        flipH: current.flipH,
        flipV: current.flipV,
        invert: current.invert,
      });

      socket.emit('viewport:update', {
        sessionId: sid,
        viewportState: { 
          imageIndex: current.imageIndex,
          zoom: current.zoom,
          pan: [current.panX, current.panY],
          voi,
          rotation: current.rotation,
          flipHorizontal: current.flipH,
          flipVertical: current.flipV,
          invert: current.invert,
          studyInstanceUID: studyUID,
        },
      });
    };

    // Poll for changes - this is the PRIMARY and most reliable method
    console.log('[Collab] Starting viewport polling (100ms interval)');
    
    // Log initial state
    const initialState = captureCurrentState();
    console.log('[Collab] Initial state:', initialState);
    
    pollTimer = setInterval(() => {
      broadcastIfChanged();
      checkStudyChange();
    }, 100);

    // Listen for keyboard events (OHIF hotkeys)
    const handleKeyDown = (e: KeyboardEvent) => {
      // Common navigation keys - trigger immediate check after a short delay
      // to allow OHIF to process the hotkey first
      const navigationKeys = [
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'PageUp', 'PageDown', 'Home', 'End',
        ' ', // spacebar
      ];
      
      if (navigationKeys.includes(e.key) || e.key.length === 1) {
        // Small delay to let OHIF process the hotkey first
        setTimeout(() => {
          broadcastIfChanged();
        }, 50);
      }
    };

    // Listen for any mouse interaction on the viewport (pan, zoom, window/level)
    const handleMouseUp = () => {
      setTimeout(() => {
        broadcastIfChanged();
      }, 50);
    };

    // Listen for wheel events (might be zoom or scroll depending on config)
    const handleWheel = () => {
      setTimeout(() => {
        broadcastIfChanged();
      }, 50);
    };

    // Add global keyboard listener
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('wheel', handleWheel, { passive: true });

    // Initial broadcast after delay
    setTimeout(broadcastIfChanged, 1000);

    return () => {
      console.log('[Collab] Stopping viewport polling');
      if (pollTimer) clearInterval(pollTimer);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('wheel', handleWheel);
      setupDoneRef.current = false;
    };
  }, [sessionId, role]);

  // ============================================
  // CONNECTION EVENT HANDLERS
  // ============================================

  useEffect(() => {
    if (!collaborationService) return;

    const handlers: Record<string, (data?: any) => void> = {
      'connection:established': () => {
        setIsConnected(true);
        setIsConnecting(false);
        setError(null);
      },
      'connection:error': (err) => {
        setIsConnected(false);
        setIsConnecting(false);
        setError(err?.message || 'Connection failed');
      },
      'connection:closed': () => {
        setIsConnected(false);
        setSessionId(null);
        setRole('follower');
      },
      'session:joined': ({ sessionId: sid, role: r }) => {
        setSessionId(sid);
        setRole(r);
        setError(null);
        setIsCreating(false);
        setIsJoining(false);
      },
      'session:left': () => {
        setSessionId(null);
        setRole('follower');
        setParticipants([]);
      },
      'role:changed': ({ role: r }) => {
        setRole(r);
      },
      'user:joined': (data) => {
        setParticipants(prev => {
          const filtered = prev.filter(p => p.userId !== data.userId);
          return [...filtered, { userId: data.userId, role: data.role }];
        });
        // Send current state to new joiner
        if (roleRef.current === 'presenter') {
          setTimeout(() => {
            const socket = getSocket();
            const sid = sessionIdRef.current;
            const imageIndex = getCurrentImageIndex();
            if (socket?.connected && sid && imageIndex >= 0) {
              socket.emit('viewport:update', { sessionId: sid, viewportState: { imageIndex } });
            }
          }, 500);
        }
      },
      'user:left': (data) => {
        setParticipants(prev => prev.filter(p => p.userId !== data.userId));
      },
      'viewport:update': (state) => {
        handleViewportUpdate(state);
      },
    };

    Object.entries(handlers).forEach(([e, h]) => collaborationService.on(e, h));

    // Check initial connection state
    if (collaborationService.isActive?.()) {
      setIsConnected(true);
      const sid = collaborationService.getSessionId?.();
      if (sid) {
        setSessionId(sid);
        setRole(collaborationService.getRole?.() || 'follower');
      }
    }

    return () => {
      Object.entries(handlers).forEach(([e, h]) => collaborationService.off(e, h));
    };
  }, [collaborationService]);

  // Direct socket listener for viewport:sync
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleViewportSync = (data: any) => {
      if (roleRef.current === 'follower' && data?.viewportState) {
        handleViewportUpdate(data.viewportState);
      }
    };

    socket.on('viewport:sync', handleViewportSync);
    return () => { socket.off('viewport:sync', handleViewportSync); };
  }, [isConnected, sessionId]);

  // ============================================
  // UI HANDLERS
  // ============================================

  const handleConnect = async () => {
    if (!collaborationService) return;
    setIsConnecting(true);
    setError(null);
    try {
      await collaborationService.connect();
    } catch (e: any) {
      setError(e.message || 'Connection failed');
      setIsConnecting(false);
    }
  };

  const handleCreateSession = async () => {
    if (!collaborationService) return;
    setIsCreating(true);
    setError(null);
    try {
      if (!collaborationService.isActive?.()) {
        await collaborationService.connect();
      }
      const activeViewportId = viewportGridService?.getActiveViewportId?.();
      const viewportState = viewportGridService?.getState?.();
      const vp = viewportState?.viewports?.get(activeViewportId);
      if (!vp?.displaySetInstanceUIDs?.length) {
        throw new Error('Please load a study first');
      }
      const displaySet = displaySetService?.getDisplaySetByUID(vp.displaySetInstanceUIDs[0]);
      if (!displaySet?.StudyInstanceUID) {
        throw new Error('Could not get study information');
      }
      await collaborationService.createSession(displaySet.StudyInstanceUID);
    } catch (e: any) {
      setError(e.message);
      setIsCreating(false);
    }
  };

  const handleJoinSession = async () => {
    if (!collaborationService || !joinSessionInput.trim()) return;
    setIsJoining(true);
    setError(null);
    try {
      if (!collaborationService.isActive?.()) {
        await collaborationService.connect();
      }
      await collaborationService.joinSession(joinSessionInput.trim(), 'follower');
      setJoinSessionInput('');
    } catch (e: any) {
      setError(e.message);
      setIsJoining(false);
    }
  };

  const handleLeaveSession = () => {
    collaborationService?.leaveSession?.();
  };

  const handleSwitchRole = () => {
    const newRole = role === 'presenter' ? 'follower' : 'presenter';
    collaborationService?.switchRole?.(newRole);
  };

  const handleCopySessionId = () => {
    if (sessionId) {
      navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // ============================================
  // RENDER
  // ============================================

  if (!servicesManager) {
    return (
      <div className="p-4 text-white">
        <Typography variant="body" color="error">
          Service manager not available
        </Typography>
      </div>
    );
  }

  return (
    <div className="p-4 text-white">
      <Typography variant="h6" className="mb-4">
        Collaboration
      </Typography>

      {/* Connection Status */}
      <div
        className={`flex items-center p-2 mb-4 rounded ${
          isConnected ? 'bg-green-900' : isConnecting ? 'bg-yellow-900' : 'bg-red-900'
        }`}
      >
        <div
          className={`w-2 h-2 rounded-full mr-2 ${
            isConnected ? 'bg-green-400' : isConnecting ? 'bg-yellow-400' : 'bg-red-400'
          }`}
        />
        <span className="text-sm">
          {isConnected ? 'Connected' : isConnecting ? 'Connecting...' : 'Disconnected'}
        </span>
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-3 mb-4 bg-red-900 border border-red-500 rounded">
          <span className="text-red-300 text-sm">{error}</span>
        </div>
      )}

      {/* Study Change Notification */}
      {studyChangeNotification && (
        <div className="p-3 mb-4 bg-yellow-900 border border-yellow-500 rounded">
          <p className="text-yellow-200 text-sm mb-2">
            📢 The presenter has switched to a different study.
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() => navigateToStudy(studyChangeNotification)}
              size="small"
              variant="contained"
              color="primary"
            >
              Follow to New Study
            </Button>
            <Button
              onClick={() => setStudyChangeNotification(null)}
              size="small"
              variant="outlined"
            >
              Stay Here
            </Button>
          </div>
        </div>
      )}

      {/* Not Connected */}
      {!isConnected && !isConnecting && (
        <Button
          onClick={handleConnect}
          className="w-full"
          variant="contained"
          color="primary"
        >
          Connect
        </Button>
      )}

      {/* Connecting */}
      {isConnecting && (
        <Button disabled className="w-full" variant="contained">
          Connecting...
        </Button>
      )}

      {/* Connected - No Session */}
      {isConnected && !sessionId && (
        <div className="space-y-4">
          <div>
            <Typography variant="subtitle" className="mb-2 block">
              Start a Session
            </Typography>
            <Button
              onClick={handleCreateSession}
              disabled={isCreating}
              className="w-full"
              variant="contained"
              color="primary"
            >
              {isCreating ? 'Creating...' : 'Create Session'}
            </Button>
          </div>

          <div className="border-t border-gray-600 my-4" />

          <div>
            <Typography variant="subtitle" className="mb-2 block">
              Join a Session
            </Typography>
            <Input
              type="text"
              placeholder="Paste session ID here"
              value={joinSessionInput}
              onChange={(e) => setJoinSessionInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleJoinSession()}
              className="mb-2"
            />
            <Button
              onClick={handleJoinSession}
              disabled={isJoining || !joinSessionInput.trim()}
              className="w-full"
              variant="contained"
              color="primary"
            >
              {isJoining ? 'Joining...' : 'Join Session'}
            </Button>
          </div>
        </div>
      )}

      {/* In Session */}
      {isConnected && sessionId && (
        <div className="space-y-4">
          {/* Session ID */}
          <div className="p-3 bg-gray-800 rounded">
            <Typography variant="subtitle" className="mb-2 block">
              Session ID
            </Typography>
            <div
              onClick={handleCopySessionId}
              className="p-2 bg-gray-900 rounded cursor-pointer hover:bg-gray-700 transition-colors"
              title="Click to copy"
            >
              <code className="text-xs text-gray-300 break-all block">
                {sessionId}
              </code>
            </div>
            <Button
              onClick={handleCopySessionId}
              size="small"
              variant="outlined"
              className="mt-2"
            >
              {copied ? 'Copied!' : 'Copy Session ID'}
            </Button>
          </div>

          {/* Role */}
          <div className="p-3 bg-gray-800 rounded">
            <div className="flex justify-between items-center">
              <div>
                <Typography variant="subtitle" className="block">
                  Your Role
                </Typography>
                <span
                  className={`text-lg font-bold ${
                    role === 'presenter' ? 'text-green-400' : 'text-blue-400'
                  }`}
                >
                  {role === 'presenter' ? '📺 Presenter' : '👁 Follower'}
                </span>
              </div>
              <Button onClick={handleSwitchRole} size="small" variant="outlined">
                Switch Role
              </Button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {role === 'presenter'
                ? 'Your viewport changes are shared with followers'
                : 'Your viewport follows the presenter'}
            </p>
          </div>

          {/* Sync Settings */}
          <div className="p-3 bg-gray-800 rounded">
            <Typography variant="subtitle" className="mb-2 block">
              Sync Settings
            </Typography>
            <div className="space-y-2">
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={true}
                  disabled
                  className="mr-2 w-4 h-4"
                />
                <span className="text-sm text-gray-300">Viewport Sync</span>
                <span className="ml-2 text-xs text-green-400">● Active</span>
              </label>
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={annotationSyncEnabled}
                  onChange={(e) => setAnnotationSyncEnabled(e.target.checked)}
                  className="mr-2 w-4 h-4"
                />
                <span className="text-sm text-gray-300">Annotation Sync</span>
                <span className={`ml-2 text-xs ${annotationSyncEnabled ? 'text-green-400' : 'text-gray-500'}`}>
                  {annotationSyncEnabled ? '● Active' : '○ Disabled'}
                </span>
              </label>
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={segmentationSyncEnabled}
                  onChange={(e) => setSegmentationSyncEnabled(e.target.checked)}
                  className="mr-2 w-4 h-4"
                />
                <span className="text-sm text-gray-300">Segmentation Sync</span>
                <span className={`ml-2 text-xs ${segmentationSyncEnabled ? 'text-green-400' : 'text-gray-500'}`}>
                  {segmentationSyncEnabled ? '● Active' : '○ Disabled'}
                </span>
              </label>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Sync annotations and MONAI Label segmentations in real-time.
            </p>
          </div>

          {/* Participants */}
          {participants.length > 0 && (
            <div className="p-3 bg-gray-800 rounded">
              <Typography variant="subtitle" className="mb-2 block">
                Participants ({participants.length})
              </Typography>
              <div className="space-y-1">
                {participants.map((p, i) => (
                  <div key={i} className="flex items-center text-xs">
                    <span
                      className={`w-2 h-2 rounded-full mr-2 ${
                        p.role === 'presenter' ? 'bg-green-400' : 'bg-blue-400'
                      }`}
                    />
                    <span className="text-gray-300">
                      {p.userId?.substring(0, 20)}...
                    </span>
                    <span className="text-gray-500 ml-1">
                      ({p.role})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Leave Button */}
          <Button
            onClick={handleLeaveSession}
            className="w-full"
            variant="outlined"
            color="secondary"
          >
            Leave Session
          </Button>
        </div>
      )}
    </div>
  );
};

CollaborationPanel.propTypes = {
  servicesManager: PropTypes.object.isRequired,
  commandsManager: PropTypes.object,
};

export default CollaborationPanel;
