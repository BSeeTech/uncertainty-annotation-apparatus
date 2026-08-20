/**
 * UserList.tsx
 * 
 * Component for displaying the list of users in a collaboration session.
 * Shows participant names, roles, and connection status.
 * 
 * Location: extensions/collaboration/src/components/UserList.tsx
 */

import React, { useState, useEffect, useCallback } from 'react';

interface Participant {
  id: string;
  name?: string;
  role: 'presenter' | 'follower';
  isConnected: boolean;
  joinedAt?: number;
  lastSeen?: number;
}

interface UserListProps {
  collaborationService: any;
  sessionId: string | null;
  currentRole: 'presenter' | 'follower' | null;
}

const UserList: React.FC<UserListProps> = ({
  collaborationService,
  sessionId,
  currentRole,
}) => {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);

  // Fetch and update participants list
  const updateParticipants = useCallback(() => {
    if (!collaborationService || !sessionId) {
      setParticipants([]);
      return;
    }

    try {
      const participantList = collaborationService.getParticipants?.() || [];
      setParticipants(participantList);
    } catch (err) {
      console.error('[UserList] Failed to get participants:', err);
    }
  }, [collaborationService, sessionId]);

  // Subscribe to participant changes
  useEffect(() => {
    if (!collaborationService || !sessionId) {
      setParticipants([]);
      return;
    }

    // Initial fetch
    updateParticipants();

    // Subscribe to participant updates
    const handleParticipantJoined = (participant: Participant) => {
      console.log('[UserList] Participant joined:', participant);
      updateParticipants();
    };

    const handleParticipantLeft = (participantId: string) => {
      console.log('[UserList] Participant left:', participantId);
      updateParticipants();
    };

    const handleParticipantsUpdated = (updatedParticipants: Participant[]) => {
      console.log('[UserList] Participants updated:', updatedParticipants);
      setParticipants(updatedParticipants);
    };

    // Register event listeners
    collaborationService.on?.('participant:joined', handleParticipantJoined);
    collaborationService.on?.('participant:left', handleParticipantLeft);
    collaborationService.on?.('participants:updated', handleParticipantsUpdated);

    // Poll for updates as fallback
    const pollInterval = setInterval(updateParticipants, 5000);

    return () => {
      collaborationService.off?.('participant:joined', handleParticipantJoined);
      collaborationService.off?.('participant:left', handleParticipantLeft);
      collaborationService.off?.('participants:updated', handleParticipantsUpdated);
      clearInterval(pollInterval);
    };
  }, [collaborationService, sessionId, updateParticipants]);

  // Styles
  const containerStyle: React.CSSProperties = {
    backgroundColor: '#1e1e1e',
    borderRadius: '8px',
    marginBottom: '12px',
    overflow: 'hidden',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    backgroundColor: '#2d2d2d',
    cursor: 'pointer',
    userSelect: 'none',
  };

  const headerTitleStyle: React.CSSProperties = {
    color: '#ffffff',
    fontSize: '13px',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  };

  const countBadgeStyle: React.CSSProperties = {
    backgroundColor: '#3b82f6',
    color: '#ffffff',
    fontSize: '11px',
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: '10px',
    minWidth: '18px',
    textAlign: 'center',
  };

  const expandIconStyle: React.CSSProperties = {
    color: '#9ca3af',
    fontSize: '12px',
    transition: 'transform 0.2s',
    transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
  };

  const listContainerStyle: React.CSSProperties = {
    maxHeight: isExpanded ? '300px' : '0',
    overflow: 'hidden',
    transition: 'max-height 0.3s ease-in-out',
  };

  const listStyle: React.CSSProperties = {
    padding: '8px',
  };

  const participantItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 10px',
    borderRadius: '6px',
    marginBottom: '4px',
    backgroundColor: '#252525',
    transition: 'background-color 0.2s',
  };

  const avatarStyle = (role: string): React.CSSProperties => ({
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    backgroundColor: role === 'presenter' ? '#059669' : '#2563eb',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#ffffff',
    fontSize: '14px',
    fontWeight: 600,
    marginRight: '10px',
    flexShrink: 0,
  });

  const participantInfoStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
  };

  const participantNameStyle: React.CSSProperties = {
    color: '#ffffff',
    fontSize: '13px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const participantRoleStyle = (role: string): React.CSSProperties => ({
    color: role === 'presenter' ? '#34d399' : '#60a5fa',
    fontSize: '11px',
    textTransform: 'capitalize',
  });

  const statusIndicatorStyle = (isConnected: boolean): React.CSSProperties => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: isConnected ? '#10b981' : '#6b7280',
    marginLeft: '8px',
    flexShrink: 0,
  });

  const emptyStateStyle: React.CSSProperties = {
    padding: '20px',
    textAlign: 'center',
    color: '#6b7280',
    fontSize: '13px',
  };

  const youBadgeStyle: React.CSSProperties = {
    backgroundColor: '#374151',
    color: '#9ca3af',
    fontSize: '10px',
    padding: '2px 6px',
    borderRadius: '4px',
    marginLeft: '6px',
  };

  // Get initials from name or generate from ID
  const getInitials = (participant: Participant): string => {
    if (participant.name) {
      return participant.name
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
    }
    return participant.role === 'presenter' ? 'P' : 'F';
  };

  // Get display name
  const getDisplayName = (participant: Participant): string => {
    if (participant.name) {
      return participant.name;
    }
    return participant.role === 'presenter' ? 'Presenter' : `Follower`;
  };

  // Check if this is the current user
  const isCurrentUser = (participant: Participant): boolean => {
    const currentId = collaborationService?.getClientId?.();
    return participant.id === currentId;
  };

  if (!sessionId) {
    return null;
  }

  return (
    <div style={containerStyle}>
      <div style={headerStyle} onClick={() => setIsExpanded(!isExpanded)}>
        <div style={headerTitleStyle}>
          <span>👥 Participants</span>
          <span style={countBadgeStyle}>{participants.length || 1}</span>
        </div>
        <span style={expandIconStyle}>▼</span>
      </div>

      <div style={listContainerStyle}>
        <div style={listStyle}>
          {participants.length > 0 ? (
            participants.map((participant) => (
              <div key={participant.id} style={participantItemStyle}>
                <div style={avatarStyle(participant.role)}>
                  {getInitials(participant)}
                </div>
                <div style={participantInfoStyle}>
                  <div style={participantNameStyle}>
                    {getDisplayName(participant)}
                    {isCurrentUser(participant) && (
                      <span style={youBadgeStyle}>You</span>
                    )}
                  </div>
                  <div style={participantRoleStyle(participant.role)}>
                    {participant.role}
                  </div>
                </div>
                <div 
                  style={statusIndicatorStyle(participant.isConnected)} 
                  title={participant.isConnected ? 'Connected' : 'Disconnected'}
                />
              </div>
            ))
          ) : (
            // Show at least the current user
            <div style={participantItemStyle}>
              <div style={avatarStyle(currentRole || 'follower')}>
                {currentRole === 'presenter' ? 'P' : 'F'}
              </div>
              <div style={participantInfoStyle}>
                <div style={participantNameStyle}>
                  {currentRole === 'presenter' ? 'Presenter' : 'Follower'}
                  <span style={youBadgeStyle}>You</span>
                </div>
                <div style={participantRoleStyle(currentRole || 'follower')}>
                  {currentRole || 'unknown'}
                </div>
              </div>
              <div style={statusIndicatorStyle(true)} title="Connected" />
            </div>
          )}

          {participants.length === 0 && currentRole === 'presenter' && (
            <div style={emptyStateStyle}>
              Share the session ID to invite others
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserList;
