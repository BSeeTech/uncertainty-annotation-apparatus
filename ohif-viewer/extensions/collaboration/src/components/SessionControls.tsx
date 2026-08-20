/**
 * SessionControls.tsx
 * 
 * Component for managing collaboration session controls.
 * Provides UI for creating, joining, and leaving sessions.
 * 
 * Location: extensions/collaboration/src/components/SessionControls.tsx
 */

import React, { useState, useCallback } from 'react';

interface SessionControlsProps {
  collaborationService: any;
  sessionId: string | null;
  role: 'presenter' | 'follower' | null;
  isConnected: boolean;
  onSessionChange?: (sessionId: string | null, role: 'presenter' | 'follower' | null) => void;
}

const SessionControls: React.FC<SessionControlsProps> = ({
  collaborationService,
  sessionId,
  role,
  isConnected,
  onSessionChange,
}) => {
  const [inputSessionId, setInputSessionId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generate a random session ID
  const generateSessionId = useCallback(() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }, []);

  // Create a new session as presenter
  const handleCreateSession = useCallback(async () => {
    if (!collaborationService) {
      setError('Collaboration service not available');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const newSessionId = generateSessionId();
      await collaborationService.createSession(newSessionId);
      onSessionChange?.(newSessionId, 'presenter');
    } catch (err: any) {
      setError(err.message || 'Failed to create session');
      console.error('[SessionControls] Create session error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [collaborationService, generateSessionId, onSessionChange]);

  // Join an existing session as follower
  const handleJoinSession = useCallback(async () => {
    if (!collaborationService) {
      setError('Collaboration service not available');
      return;
    }

    if (!inputSessionId.trim()) {
      setError('Please enter a session ID');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await collaborationService.joinSession(inputSessionId.trim().toUpperCase());
      onSessionChange?.(inputSessionId.trim().toUpperCase(), 'follower');
    } catch (err: any) {
      setError(err.message || 'Failed to join session');
      console.error('[SessionControls] Join session error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [collaborationService, inputSessionId, onSessionChange]);

  // Leave the current session
  const handleLeaveSession = useCallback(async () => {
    if (!collaborationService) {
      setError('Collaboration service not available');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await collaborationService.leaveSession();
      onSessionChange?.(null, null);
      setInputSessionId('');
    } catch (err: any) {
      setError(err.message || 'Failed to leave session');
      console.error('[SessionControls] Leave session error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [collaborationService, onSessionChange]);

  // Copy session ID to clipboard
  const handleCopySessionId = useCallback(() => {
    if (sessionId) {
      navigator.clipboard.writeText(sessionId).then(() => {
        // Could show a toast notification here
        console.log('[SessionControls] Session ID copied to clipboard');
      }).catch(err => {
        console.error('[SessionControls] Failed to copy:', err);
      });
    }
  }, [sessionId]);

  // Styles
  const containerStyle: React.CSSProperties = {
    padding: '12px',
    backgroundColor: '#1e1e1e',
    borderRadius: '8px',
    marginBottom: '12px',
  };

  const labelStyle: React.CSSProperties = {
    color: '#9ca3af',
    fontSize: '12px',
    marginBottom: '4px',
    display: 'block',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    backgroundColor: '#2d2d2d',
    border: '1px solid #404040',
    borderRadius: '4px',
    color: '#ffffff',
    fontSize: '14px',
    marginBottom: '8px',
    boxSizing: 'border-box',
  };

  const buttonStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 16px',
    borderRadius: '4px',
    border: 'none',
    fontSize: '14px',
    fontWeight: 500,
    cursor: isLoading ? 'not-allowed' : 'pointer',
    opacity: isLoading ? 0.6 : 1,
    marginBottom: '8px',
    transition: 'background-color 0.2s',
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: '#3b82f6',
    color: '#ffffff',
  };

  const secondaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: '#374151',
    color: '#ffffff',
  };

  const dangerButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: '#dc2626',
    color: '#ffffff',
  };

  const sessionInfoStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    backgroundColor: '#2d2d2d',
    borderRadius: '4px',
    marginBottom: '8px',
  };

  const sessionIdStyle: React.CSSProperties = {
    color: '#ffffff',
    fontSize: '18px',
    fontWeight: 600,
    letterSpacing: '2px',
  };

  const roleTagStyle: React.CSSProperties = {
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    backgroundColor: role === 'presenter' ? '#059669' : '#2563eb',
    color: '#ffffff',
  };

  const errorStyle: React.CSSProperties = {
    color: '#ef4444',
    fontSize: '12px',
    marginTop: '8px',
    padding: '8px',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: '4px',
  };

  const statusDotStyle: React.CSSProperties = {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: isConnected ? '#10b981' : '#ef4444',
    display: 'inline-block',
    marginRight: '6px',
  };

  // Render active session view
  if (sessionId && role) {
    return (
      <div style={containerStyle}>
        <label style={labelStyle}>
          <span style={statusDotStyle} />
          {isConnected ? 'Connected' : 'Disconnected'}
        </label>
        
        <div style={sessionInfoStyle}>
          <span style={sessionIdStyle}>{sessionId}</span>
          <span style={roleTagStyle}>{role}</span>
        </div>

        <button
          style={secondaryButtonStyle}
          onClick={handleCopySessionId}
          disabled={isLoading}
        >
          📋 Copy Session ID
        </button>

        <button
          style={dangerButtonStyle}
          onClick={handleLeaveSession}
          disabled={isLoading}
        >
          {isLoading ? 'Leaving...' : '🚪 Leave Session'}
        </button>

        {error && <div style={errorStyle}>{error}</div>}
      </div>
    );
  }

  // Render session creation/join view
  return (
    <div style={containerStyle}>
      <label style={labelStyle}>Start a New Session</label>
      <button
        style={primaryButtonStyle}
        onClick={handleCreateSession}
        disabled={isLoading}
      >
        {isLoading ? 'Creating...' : '🎬 Create Session (Presenter)'}
      </button>

      <div style={{ 
        textAlign: 'center', 
        color: '#6b7280', 
        fontSize: '12px', 
        margin: '12px 0',
        position: 'relative',
      }}>
        <span style={{ 
          backgroundColor: '#1e1e1e', 
          padding: '0 8px',
          position: 'relative',
          zIndex: 1,
        }}>
          or
        </span>
        <div style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          height: '1px',
          backgroundColor: '#374151',
          zIndex: 0,
        }} />
      </div>

      <label style={labelStyle}>Join Existing Session</label>
      <input
        type="text"
        style={inputStyle}
        placeholder="Enter Session ID"
        value={inputSessionId}
        onChange={(e) => setInputSessionId(e.target.value.toUpperCase())}
        maxLength={10}
        disabled={isLoading}
      />
      
      <button
        style={secondaryButtonStyle}
        onClick={handleJoinSession}
        disabled={isLoading || !inputSessionId.trim()}
      >
        {isLoading ? 'Joining...' : '👥 Join Session (Follower)'}
      </button>

      {error && <div style={errorStyle}>{error}</div>}
    </div>
  );
};

export default SessionControls;
