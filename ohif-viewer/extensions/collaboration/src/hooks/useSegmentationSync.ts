/**
 * C:\medical-imaging-platform\ohif-viewer\extensions\collaboration\src\hooks\useSegmentationSync.ts
 * 
 * React hook for real-time segmentation synchronization in collaboration sessions.
 * Works with MONAI Label DeepEdit and other segmentation tools.
 * 
 * IMPORTANT: This syncs labelmap data for MONAI Label segmentations.
 * For large segmentations, consider using DICOM SEG storage instead.
 * 
 * Location: extensions/collaboration/src/hooks/useSegmentationSync.ts
 */

import { useEffect, useRef, useCallback, useMemo } from 'react';

interface UseSegmentationSyncProps {
  collaborationService: CollaborationService;
  servicesManager: ServicesManager;
  isEnabled: boolean;
  role: 'presenter' | 'follower';
  sessionId: string | null;
  options?: SegmentationSyncOptions;
}

interface SegmentationSyncOptions {
  /** Maximum size for labelmap sync (default: 10MB) */
  maxLabelmapSize?: number;
  /** Throttle time between broadcasts (default: 500ms) */
  broadcastThrottleMs?: number;
  /** ToolGroup ID for segmentation display (default: 'default') */
  toolGroupId?: string;
  /** Enable chunking for large labelmaps */
  enableChunking?: boolean;
  /** Chunk size for labelmap transfer (default: 5MB) */
  chunkSize?: number;
}

interface SegmentData {
  segmentIndex: number;
  label: string;
  color: [number, number, number, number];
  isVisible: boolean;
  isLocked: boolean;
}

interface SegmentationSyncData {
  segmentationId: string;
  label: string;
  type: string;
  segments: SegmentData[];
  // Labelmap data as base64 encoded array (or chunks)
  labelmapData?: string | string[];
  labelmapDimensions?: [number, number, number];
  labelmapChunks?: number;
  // Reference info
  referencedVolumeId?: string;
  referencedSeriesUID?: string;
  // Orientation info
  direction?: number[];
  spacing?: number[];
  origin?: number[];
  // Presenter viewport state (for syncing camera/slice)
  presenterCamera?: {
    focalPoint: number[];
    position: number[];
    viewUp?: number[];
    viewPlaneNormal?: number[];
    parallelScale?: number;
  };
  presenterSliceIndex?: number;
}

interface CollaborationService {
  socket: {
    emit: (event: string, data: any) => void;
    on: (event: string, handler: (data: any) => void) => void;
    off: (event: string, handler: (data: any) => void) => void;
    connected: boolean;
  };
}

interface ServicesManager {
  services: {
    segmentationService: SegmentationService;
    cornerstoneViewportService: CornerstoneViewportService;
    toolGroupService?: ToolGroupService;
  };
}

interface SegmentationService {
  getSegmentation: (id: string) => any;
  addSegmentation: (config: any) => Promise<void>;
  remove: (id: string) => void;
  subscribe: (event: string, handler: Function) => { unsubscribe: () => void };
  EVENTS: {
    SEGMENTATION_ADDED: string;
    SEGMENTATION_UPDATED: string;
    SEGMENTATION_REMOVED: string;
    SEGMENTATION_DATA_MODIFIED: string;
  };
  setSegmentVisibility: (segmentationId: string, segmentIndex: number, isVisible: boolean) => void;
  addSegmentationRepresentationToToolGroup: (toolGroupId: string, segmentationId: string) => Promise<void>;
}

interface CornerstoneViewportService {
  getViewportIds: () => string[];
  getRenderingEngine: () => any;
}

interface ToolGroupService {
  getToolGroupIds: () => string[];
}


// =============================================================================
// ORIENTATION HELPER FUNCTIONS
// =============================================================================

/**
 * Flips labelmap data along the Y-axis (vertical flip within each slice)
 */
function flipLabelmapY(data: Uint8Array, dims: number[]): Uint8Array {
  const [width, height, depth] = dims;
  const sliceSize = width * height;
  const result = new Uint8Array(data.length);
  
  for (let z = 0; z < depth; z++) {
    const sliceOffset = z * sliceSize;
    for (let y = 0; y < height; y++) {
      const srcRowStart = sliceOffset + (height - 1 - y) * width;
      const dstRowStart = sliceOffset + y * width;
      result.set(data.subarray(srcRowStart, srcRowStart + width), dstRowStart);
    }
  }
  
  return result;
}

/**
 * Flips labelmap data along the X-axis (horizontal flip within each row)
 */
function flipLabelmapX(data: Uint8Array, dims: number[]): Uint8Array {
  const [width, height, depth] = dims;
  const sliceSize = width * height;
  const result = new Uint8Array(data.length);
  
  for (let z = 0; z < depth; z++) {
    const sliceOffset = z * sliceSize;
    for (let y = 0; y < height; y++) {
      const rowOffset = sliceOffset + y * width;
      for (let x = 0; x < width; x++) {
        result[rowOffset + x] = data[rowOffset + (width - 1 - x)];
      }
    }
  }
  
  return result;
}

/**
 * Combined Y + X flip (vertical and horizontal)
 */
function flipLabelmapYX(data: Uint8Array, dims: number[]): Uint8Array {
  // Apply Y-flip first, then X-flip
  const yFlipped = flipLabelmapY(data, dims);
  return flipLabelmapX(yFlipped, dims);
}

// Chunk size for base64 encoding/decoding (5MB)
const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
// Maximum total size for labelmap sync (10MB)
const DEFAULT_MAX_LABELMAP_SIZE = 10 * 1024 * 1024;
// Throttle broadcasts to avoid spam
const DEFAULT_BROADCAST_THROTTLE_MS = 500;
// Cleanup old broadcast timers after 5 minutes
const BROADCAST_TIMER_CLEANUP_MS = 5 * 60 * 1000;

/**
 * Hook for synchronizing segmentations between collaboration participants
 */
export function useSegmentationSync({
  collaborationService,
  servicesManager,
  isEnabled,
  role,
  sessionId,
  options = {},
}: UseSegmentationSyncProps) {
  const {
    maxLabelmapSize = DEFAULT_MAX_LABELMAP_SIZE,
    broadcastThrottleMs = DEFAULT_BROADCAST_THROTTLE_MS,
    toolGroupId: propToolGroupId = 'default',
    enableChunking = true,
    chunkSize = DEFAULT_CHUNK_SIZE,
  } = options;

  const isProcessingRemoteRef = useRef(false);
  const pendingSegmentationsRef = useRef<Set<string>>(new Set());
  const pendingPromisesRef = useRef<Map<string, Promise<any>>>(new Map());
  const subscriptionsRef = useRef<Array<{ unsubscribe: () => void }>>([]);
  const lastBroadcastTimeRef = useRef<Map<string, number>>(new Map());
  const cleanupTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Get services
  const getSegmentationService = useCallback(() => {
    return servicesManager?.services?.segmentationService;
  }, [servicesManager]);

  const getCornerstoneViewportService = useCallback(() => {
    return servicesManager?.services?.cornerstoneViewportService;
  }, [servicesManager]);

  const getToolGroupId = useCallback(() => {
    // Try to get toolGroupId from toolGroupService if available
    if (servicesManager?.services?.toolGroupService) {
      const toolGroupIds = servicesManager.services.toolGroupService.getToolGroupIds();
      return toolGroupIds.length > 0 ? toolGroupIds[0] : propToolGroupId;
    }
    return propToolGroupId;
  }, [servicesManager, propToolGroupId]);

  /**
   * Cleanup old broadcast timers to prevent memory leak
   */
  const cleanupBroadcastTimers = useCallback(() => {
    const now = Date.now();
    const timers = lastBroadcastTimeRef.current;
    
    for (const [segId, timestamp] of timers.entries()) {
      if (now - timestamp > BROADCAST_TIMER_CLEANUP_MS) {
        timers.delete(segId);
      }
    }
  }, []);

  /**
   * Base64 encode Uint8Array in chunks to avoid maximum string length issues
   */
  const base64EncodeChunked = useCallback((uint8Array: Uint8Array): string[] => {
    if (!enableChunking || uint8Array.length <= chunkSize) {
      // Single chunk for small arrays
      try {
        const binaryString = Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
        return [btoa(binaryString)];
      } catch (e) {
        console.error('[SegmentationSync] Failed to encode base64:', e);
        return [];
      }
    }

    // Split into chunks
    const chunks: string[] = [];
    const totalChunks = Math.ceil(uint8Array.length / chunkSize);
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, uint8Array.length);
      const chunk = uint8Array.slice(start, end);
      
      try {
        const binaryString = Array.from(chunk, byte => String.fromCharCode(byte)).join('');
        chunks.push(btoa(binaryString));
      } catch (e) {
        console.error(`[SegmentationSync] Failed to encode chunk ${i}:`, e);
        chunks.push('');
      }
    }
    
    return chunks;
  }, [enableChunking, chunkSize]);

  /**
   * Base64 decode string to Uint8Array (handles chunked or single)
   */
  const base64DecodeToUint8Array = useCallback((base64Data: string | string[]): Uint8Array => {
    if (Array.isArray(base64Data)) {
      // Concatenate chunks
      const totalLength = base64Data.reduce((sum, chunk) => sum + atob(chunk).length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      
      for (const chunk of base64Data) {
        const binaryString = atob(chunk);
        for (let i = 0; i < binaryString.length; i++) {
          result[offset++] = binaryString.charCodeAt(i);
        }
      }
      return result;
    } else {
      // Single chunk
      const binaryString = atob(base64Data);
      const result = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        result[i] = binaryString.charCodeAt(i);
      }
      return result;
    }
  }, []);

  /**
   * Validate segmentation sync data
   */
  const validateSegmentationSyncData = useCallback((data: any): data is SegmentationSyncData => {
    if (!data || typeof data !== 'object') return false;
    if (!data.segmentationId || typeof data.segmentationId !== 'string') return false;
    if (!Array.isArray(data.segments)) return false;
    
    // Validate labelmap data if present
    if (data.labelmapData !== undefined) {
      if (typeof data.labelmapData !== 'string' && !Array.isArray(data.labelmapData)) {
        return false;
      }
      if (!data.labelmapDimensions || !Array.isArray(data.labelmapDimensions)) {
        return false;
      }
    }
    
    // Validate base64 string(s)
    if (data.labelmapData) {
      const validateBase64 = (str: string) => /^[A-Za-z0-9+/]*={0,2}$/.test(str);
      
      if (Array.isArray(data.labelmapData)) {
        if (!data.labelmapData.every(validateBase64)) return false;
      } else if (!validateBase64(data.labelmapData)) {
        return false;
      }
    }
    
    return true;
  }, []);

  /**
   * Find matching volume by SeriesInstanceUID
   */
  const findMatchingVolume = useCallback((referencedSeriesUID: string): string | null => {
    try {
      const cornerstone = (window as any).cornerstone;
      if (!cornerstone?.cache) return null;
      
      const volumes = cornerstone.cache.getVolumes();
      for (const [volumeId, volume] of volumes) {
        const metadata = volume.metadata || {};
        if (metadata.SeriesInstanceUID === referencedSeriesUID) {
          return volumeId;
        }
      }
      
      // Fallback: check if volumeId contains the series UID
      for (const [volumeId] of volumes) {
        if (volumeId.includes(referencedSeriesUID)) {
          return volumeId;
        }
      }
      
      return null;
    } catch (e) {
      console.warn('[SegmentationSync] Error finding matching volume:', e);
      return null;
    }
  }, []);

  /**
   * Serialize segmentation including labelmap data for transmission
   */
  const serializeSegmentation = useCallback((segmentation: any): SegmentationSyncData | null => {
    if (!segmentation) return null;

    try {
      const segments: SegmentData[] = [];
      
      // Get segments
      if (segmentation.segments) {
        const segmentsIterable = segmentation.segments instanceof Map 
          ? segmentation.segments.entries()
          : Object.entries(segmentation.segments);
        
        for (const [index, segment] of segmentsIterable) {
          if (segment) {
            segments.push({
              segmentIndex: Number(index),
              label: segment.label || `Segment ${index}`,
              color: segment.color || [255, 0, 0, 255],
              isVisible: segment.isVisible !== false,
              isLocked: segment.isLocked || false,
            });
          }
        }
      }

      const syncData: SegmentationSyncData = {
        segmentationId: segmentation.segmentationId,
        label: segmentation.label || 'Segmentation',
        type: segmentation.type || 'LABELMAP',
        segments,
      };

      // Try to get labelmap data from Cornerstone cache
      try {
        const cornerstone = (window as any).cornerstone;
        if (cornerstone?.cache) {
          const representationData = segmentation.representationData;
          if (representationData?.LABELMAP?.volumeId) {
            const volumeId = representationData.LABELMAP.volumeId;
            const volume = cornerstone.cache.getVolume(volumeId);
            
            if (volume?.scalarData) {
              // Convert to Uint8Array
              const scalarData = volume.scalarData;
              const uint8Array = new Uint8Array(scalarData.buffer);
              
              // Check size limit
              if (uint8Array.length < maxLabelmapSize) {
                // Encode labelmap data
                const encodedChunks = base64EncodeChunked(uint8Array);
                if (encodedChunks.length > 0) {
                  if (encodedChunks.length === 1) {
                    syncData.labelmapData = encodedChunks[0];
                  } else {
                    syncData.labelmapData = encodedChunks;
                    syncData.labelmapChunks = encodedChunks.length;
                  }
                  syncData.labelmapDimensions = volume.dimensions;
                  syncData.referencedVolumeId = volumeId;
                  
                  // Try to get series UID for better matching
                  if (volume.metadata?.SeriesInstanceUID) {
                    syncData.referencedSeriesUID = volume.metadata.SeriesInstanceUID;
                  }
                  
                  console.log('[SegmentationSync] Serialized labelmap data, size:', uint8Array.length, 
                    'chunks:', encodedChunks.length);
                }
              } else {
                console.warn('[SegmentationSync] Labelmap too large for sync:', uint8Array.length, 
                  'max:', maxLabelmapSize);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[SegmentationSync] Could not serialize labelmap data:', e);
      }

      return syncData;
    } catch (e) {
      console.error('[SegmentationSync] Failed to serialize segmentation:', e);
      return null;
    }
  }, [maxLabelmapSize, base64EncodeChunked]);

  /**
   * Apply remote segmentation on follower
   */
  const applyRemoteSegmentation = useCallback(async (segData: SegmentationSyncData): Promise<void> => {
    // Validate incoming data
    if (!validateSegmentationSyncData(segData)) {
      console.error('[SegmentationSync] Invalid segmentation sync data');
      return;
    }

    const segmentationId = segData.segmentationId;
    const segmentationService = getSegmentationService();
    if (!segmentationService) {
      console.warn('[SegmentationSync] SegmentationService not available');
      return;
    }

    // Check if we're already processing this segmentation
    if (pendingSegmentationsRef.current.has(segmentationId)) {
      console.log('[SegmentationSync] Already processing segmentation:', segmentationId);
      return;
    }

    // Create a promise to track this operation
    const operationPromise = (async () => {
      isProcessingRemoteRef.current = true;
      pendingSegmentationsRef.current.add(segmentationId);

      try {
        console.log('[SegmentationSync] Applying remote segmentation:', segmentationId);

        // Performance monitoring
        const perfStart = performance.now();

        // Check if we have labelmap data
        if (segData.labelmapData && segData.labelmapDimensions) {
          console.log('[SegmentationSync] Received labelmap data, attempting to create segmentation');
          
          try {
            const cornerstone = (window as any).cornerstone;
            
            if (!cornerstone) {
              console.error('[SegmentationSync] Cornerstone not available');
              return;
            }

            // Decode labelmap data
            const uint8Array = base64DecodeToUint8Array(segData.labelmapData);
            console.log('[SegmentationSync] Decoded labelmap data, size:', uint8Array.length);

            // Helper to check if a volumeId is valid (exists in cache)
            const isValidVolumeId = (volumeId: string | undefined): boolean => {
              if (!volumeId) return false;
              // A valid volume ID should not be a simple number (segmentation IDs are numbers)
              if (/^\d+$/.test(volumeId)) return false;
              try {
                const volume = cornerstone.cache.getVolume(volumeId);
                return !!volume;
              } catch {
                return false;
              }
            };

            // Helper to create volume from stack images
            const createVolumeFromStack = async (seriesUID: string): Promise<string | null> => {
              try {
                console.log('[SegmentationSync] Attempting to create volume from stack for series:', seriesUID);
                
                // Get DisplaySetService to find the display set
                const displaySetService = servicesManager?.services?.displaySetService;
                if (!displaySetService) {
                  console.log('[SegmentationSync] DisplaySetService not available');
                  return null;
                }

                // Find the display set for this series
                const displaySets = displaySetService.getActiveDisplaySets?.() || [];
                const matchingDisplaySet = displaySets.find((ds: any) => 
                  ds.SeriesInstanceUID === seriesUID
                );

                if (!matchingDisplaySet) {
                  console.log('[SegmentationSync] No matching display set found for series:', seriesUID);
                  return null;
                }

                console.log('[SegmentationSync] Found display set:', matchingDisplaySet.displaySetInstanceUID);

                // Use the OHIF command to convert stack to volume
                const commandsManager = servicesManager?.services?.commandsManager;
                if (commandsManager?.runCommand) {
                  try {
                    // Try to use OHIF's built-in command to convert to volume
                    await commandsManager.runCommand('convertStackToVolume', {
                      displaySetInstanceUID: matchingDisplaySet.displaySetInstanceUID,
                    });
                    
                    // Wait a bit for the volume to be created
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Check if volume now exists
                    const volumes = cornerstone.cache?.getVolumes?.() || [];
                    for (const vol of volumes) {
                      if (vol.volumeId?.includes('cornerstoneStreamingImageVolume')) {
                        console.log('[SegmentationSync] Volume created:', vol.volumeId);
                        return vol.volumeId;
                      }
                    }
                  } catch (cmdError) {
                    console.log('[SegmentationSync] convertStackToVolume command failed:', cmdError);
                  }
                }

                // Alternative: Try to create volume directly using volumeLoader
                const imageIds = matchingDisplaySet.images?.map((img: any) => img.imageId) || 
                                 matchingDisplaySet.imageIds || [];
                
                if (imageIds.length === 0) {
                  console.log('[SegmentationSync] No image IDs found in display set');
                  return null;
                }

                console.log('[SegmentationSync] Creating volume from', imageIds.length, 'images');

                const volumeId = `cornerstoneStreamingImageVolume:${matchingDisplaySet.displaySetInstanceUID}`;
                
                // Check if volume loader is available
                if (cornerstone.volumeLoader?.createAndCacheVolume) {
                  try {
                    const volume = await cornerstone.volumeLoader.createAndCacheVolume(volumeId, {
                      imageIds,
                    });
                    
                    // Load the volume
                    if (volume?.load) {
                      await volume.load();
                    }
                    
                    console.log('[SegmentationSync] Volume created and loaded:', volumeId);
                    return volumeId;
                  } catch (volError) {
                    console.log('[SegmentationSync] Failed to create volume:', volError);
                  }
                }

                return null;
              } catch (error) {
                console.error('[SegmentationSync] Error creating volume from stack:', error);
                return null;
              }
            };

            // Helper function to find reference volume with retries
            const findReferenceVolumeWithRetry = async (maxRetries = 15, retryDelay = 500): Promise<string | null> => {
              for (let attempt = 0; attempt < maxRetries; attempt++) {
                // Log available volumes for debugging
                const allVolumes = cornerstone.cache?.getVolumes?.() || [];
                const volumeIds = allVolumes.map?.((v: any) => v.volumeId) || [];
                console.log(`[SegmentationSync] Volumes in cache (attempt ${attempt + 1}):`, allVolumes.length, volumeIds);

                // Method 1: Try to find by SeriesInstanceUID (most reliable)
                if (segData.referencedSeriesUID) {
                  const matchedVolumeId = findMatchingVolume(segData.referencedSeriesUID);
                  if (matchedVolumeId && isValidVolumeId(matchedVolumeId)) {
                    console.log('[SegmentationSync] Found matching volume by SeriesInstanceUID:', matchedVolumeId);
                    return matchedVolumeId;
                  }
                }
                
                // Method 2: Get from active viewport (if it's a volume viewport)
                const viewportService = getCornerstoneViewportService();
                const viewportIds = viewportService?.getViewportIds?.() || [];
                
                if (viewportIds.length > 0) {
                  const renderingEngines = cornerstone.getRenderingEngines();
                  if (renderingEngines?.length) {
                    const renderingEngine = viewportService?.getRenderingEngine?.() || renderingEngines[0];
                    const viewport = renderingEngine.getViewport(viewportIds[0]);
                    
                    // Check if viewport has actors with valid volume IDs
                    if (viewport?.getActors) {
                      const actors = viewport.getActors();
                      for (const actor of actors || []) {
                        if (actor?.uid && isValidVolumeId(actor.uid)) {
                          console.log('[SegmentationSync] Found volume from viewport actor:', actor.uid);
                          return actor.uid;
                        }
                      }
                    }
                  }
                }

                // Method 3: Use any volume in cache that looks like an image volume
                for (const vol of allVolumes) {
                  const volumeId = vol?.volumeId;
                  if (volumeId && isValidVolumeId(volumeId) && volumeId.includes('cornerstoneStreamingImageVolume')) {
                    console.log('[SegmentationSync] Found volume from cache:', volumeId);
                    return volumeId;
                  }
                }

                // Method 4: On attempt 3, try to create volume from stack
                if (attempt === 2 && segData.referencedSeriesUID) {
                  console.log('[SegmentationSync] No volume found, attempting to create from stack...');
                  const createdVolumeId = await createVolumeFromStack(segData.referencedSeriesUID);
                  if (createdVolumeId) {
                    return createdVolumeId;
                  }
                }

                // If not found and not last attempt, wait and retry
                if (attempt < maxRetries - 1) {
                  console.log(`[SegmentationSync] Volume not found, retrying in ${retryDelay}ms... (attempt ${attempt + 1}/${maxRetries})`);
                  await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
              }
              return null;
            };

            // Find the reference volume with retry
            const referenceVolumeId = await findReferenceVolumeWithRetry();

            if (!referenceVolumeId) {
              console.error('[SegmentationSync] Could not find reference volume after retries');
              return;
            }

            console.log('[SegmentationSync] Using reference volume:', referenceVolumeId);

            // CRITICAL: Convert viewport to volume mode if it's still a stack viewport
            const viewportService = getCornerstoneViewportService();
            const viewportIds = viewportService?.getViewportIds?.() || [];
            
            if (viewportIds.length > 0) {
              const renderingEngine = viewportService?.getRenderingEngine?.();
              const viewport = renderingEngine?.getViewport(viewportIds[0]);
              
              if (viewport?.type === 'stack') {
                console.log('[SegmentationSync] Converting stack viewport to volume viewport...');
                
                // Capture current stack state before conversion
                let currentSliceIndex = 0;
                try {
                  currentSliceIndex = viewport.getCurrentImageIdIndex?.() || 0;
                  console.log('[SegmentationSync] Current slice index before conversion:', currentSliceIndex);
                } catch (e) {
                  console.log('[SegmentationSync] Could not get current slice index');
                }
                
                // Get the current viewport element
                const element = viewport?.element;
                if (element && renderingEngine) {
                  try {
                    // Disable the current stack viewport
                    const viewportInput = {
                      viewportId: viewportIds[0],
                      type: 'orthographic' as const,
                      element,
                      defaultOptions: {
                        orientation: 'acquisition' as any,
                        background: [0, 0, 0] as [number, number, number],
                      },
                    };
                    
                    // Re-enable as volume viewport
                    renderingEngine.enableElement(viewportInput);
                    
                    // Get the new viewport and set the volume
                    const volumeViewport = renderingEngine.getViewport(viewportIds[0]);
                    if (volumeViewport && 'setVolumes' in volumeViewport) {
                      await (volumeViewport as any).setVolumes([
                        { volumeId: referenceVolumeId },
                      ]);
                      console.log('[SegmentationSync] Viewport converted to volume mode');
                      
                      // Apply flip properties to match the expected view
                      try {
                        // First try setProperties (may not work on all Cornerstone versions)
                        if (volumeViewport.setProperties) {
                          volumeViewport.setProperties({ 
                            flipHorizontal: true, 
                            flipVertical: true 
                          });
                          console.log('[SegmentationSync] Applied viewport flip properties (H+V)');
                        }
                        
                        // Log camera for debugging
                        const camera = volumeViewport.getCamera?.();
                        if (camera) {
                          console.log('[SegmentationSync] Camera after volume set:', JSON.stringify(camera));
                        }
                        
                        // Render to apply changes
                        volumeViewport.render?.();
                        
                        // Navigate to first slice using camera Z position
                        // In volume viewports, the slice is controlled by camera focalPoint Z coordinate
                        const refVolume = cornerstone.cache.getVolume(referenceVolumeId);
                        console.log('[SegmentationSync] Attempting slice navigation...');
                        console.log('[SegmentationSync] Volume dimensions:', refVolume?.dimensions);
                        console.log('[SegmentationSync] Volume origin:', refVolume?.origin);
                        console.log('[SegmentationSync] Volume spacing:', refVolume?.spacing);
                        
                        if (refVolume && camera) {
                          // Calculate Z position for first slice (slice 0)
                          const originZ = refVolume.origin?.[2] || 0;
                          const spacingZ = refVolume.spacing?.[2] || 5;
                          const numSlices = refVolume.dimensions?.[2] || 38;
                          
                          // First slice Z = origin Z
                          // Last slice Z = origin Z + (numSlices - 1) * spacing Z
                          const firstSliceZ = originZ;
                          const lastSliceZ = originZ + (numSlices - 1) * spacingZ;
                          const currentZ = camera.focalPoint[2];
                          
                          console.log('[SegmentationSync] Slice Z range:', firstSliceZ, 'to', lastSliceZ, 'current:', currentZ);
                          
                          // Move camera to first slice
                          const deltaZ = firstSliceZ - currentZ;
                          const newCamera = {
                            ...camera,
                            focalPoint: [camera.focalPoint[0], camera.focalPoint[1], firstSliceZ],
                            position: [camera.position[0], camera.position[1], camera.position[2] + deltaZ],
                          };
                          
                          volumeViewport.setCamera(newCamera);
                          volumeViewport.render?.();
                          console.log('[SegmentationSync] ✅ Moved camera to first slice (Z=' + firstSliceZ + ')');
                          
                          // Verify
                          const verifyCamera = volumeViewport.getCamera?.();
                          console.log('[SegmentationSync] Camera after move:', JSON.stringify(verifyCamera));
                        }
                      } catch (flipError) {
                        console.log('[SegmentationSync] Flip/slice adjustment failed:', flipError);
                      }
                    }
                  } catch (conversionError) {
                    console.log('[SegmentationSync] Viewport conversion failed:', conversionError);
                  }
                }
              }
            }

            // Create a new segmentation volume
            const segmentationVolumeId = `segmentation_${segmentationId}`;
            
            // Check if it already exists
            let segmentationVolume = cornerstone.cache.getVolume(segmentationVolumeId);
            
            if (!segmentationVolume) {
              // Create derived segmentation volume
              if (cornerstone.volumeLoader?.createAndCacheDerivedSegmentationVolume) {
                segmentationVolume = await cornerstone.volumeLoader.createAndCacheDerivedSegmentationVolume(
                  referenceVolumeId,
                  { volumeId: segmentationVolumeId }
                );
                console.log('[SegmentationSync] Created derived segmentation volume');
              } else {
                console.error('[SegmentationSync] Cornerstone volumeLoader not available');
                return;
              }
            }

            if (segmentationVolume?.scalarData) {
              // Store the decoded data for later - we'll copy AFTER adding to csTools
              const labelmapDataToCopy = uint8Array;
              console.log('[SegmentationSync] Labelmap data ready, length:', labelmapDataToCopy.length);

              // Add segmentation to the segmentation service
              const segmentationConfig = {
                segmentationId,
                representation: {
                  type: 'LABELMAP',
                  data: {
                    volumeId: segmentationVolumeId,
                  },
                },
                segments: {} as Record<number, any>,
              };

              // Add segment info
              segData.segments.forEach((seg) => {
                segmentationConfig.segments[seg.segmentIndex] = {
                  segmentIndex: seg.segmentIndex,
                  label: seg.label,
                  color: seg.color,
                  isVisible: seg.isVisible,
                  isLocked: seg.isLocked,
                };
              });

              // Check if segmentation exists
              const existing = segmentationService.getSegmentation(segmentationId);
              
              if (!existing) {
                // Add new segmentation - try different API methods
                console.log('[SegmentationSync] Adding segmentation, available methods:', 
                  Object.getOwnPropertyNames(Object.getPrototypeOf(segmentationService)).filter(m => m.includes('add') || m.includes('Add') || m.includes('create') || m.includes('Create')));
                
                // Build segments as a Map (OHIF expects iterable segments)
                const segmentsMap = new Map<number, any>();
                if (segData.segments) {
                  segData.segments.forEach((seg: any) => {
                    segmentsMap.set(seg.segmentIndex, {
                      segmentIndex: seg.segmentIndex,
                      label: seg.label || `Segment ${seg.segmentIndex}`,
                      color: seg.color,
                      isVisible: seg.isVisible !== false,
                      isLocked: seg.isLocked || false,
                    });
                  });
                }

                // Build the segmentation object for OHIF's API
                const segmentationForService = {
                  id: segmentationId,
                  label: segData.label || 'Remote Segmentation',
                  segments: segmentsMap,
                  activeSegmentIndex: segData.activeSegmentIndex || 1,
                  representationData: {
                    LABELMAP: {
                      volumeId: segmentationVolumeId,
                    },
                  },
                  type: 'LABELMAP',
                };

                // Use cornerstoneTools segmentation API directly (most reliable)
                const csTools = (window as any).cornerstoneTools;
                console.log('[SegmentationSync] Using csTools segmentation API');
                
                if (csTools?.segmentation) {
                  try {
                    // Step 1: Add segmentation to csTools state
                    csTools.segmentation.addSegmentations([{
                      segmentationId,
                      representation: {
                        type: csTools.Enums?.SegmentationRepresentations?.Labelmap || 'LABELMAP',
                        data: { volumeId: segmentationVolumeId },
                      },
                    }]);
                    console.log('[SegmentationSync] Added segmentation to csTools state');
                    
                    // Step 2: Get the tool group
                    const currentToolGroupId = getToolGroupId();
                    console.log('[SegmentationSync] Tool group ID:', currentToolGroupId);
                    
                    if (currentToolGroupId) {
                      // Step 3: Add segmentation representation to tool group
                      await csTools.segmentation.addSegmentationRepresentations(currentToolGroupId, [
                        {
                          segmentationId,
                          type: csTools.Enums?.SegmentationRepresentations?.Labelmap || 'LABELMAP',
                        },
                      ]);
                      console.log('[SegmentationSync] Added representation to tool group via csTools');
                    }
                    
                    // Also try OHIF service (for UI sync)
                    try {
                      await segmentationService.addOrUpdateSegmentation(segmentationForService);
                      console.log('[SegmentationSync] Also registered with OHIF service');
                    } catch (ohifError) {
                      console.log('[SegmentationSync] OHIF service registration optional:', ohifError);
                    }
                    
                  } catch (csToolsError) {
                    console.error('[SegmentationSync] csTools segmentation API failed:', csToolsError);
                    
                    // Fallback: Try OHIF API
                    if (typeof segmentationService.addOrUpdateSegmentation === 'function') {
                      try {
                        await segmentationService.addOrUpdateSegmentation(segmentationForService);
                        console.log('[SegmentationSync] Fallback: Added via addOrUpdateSegmentation');
                        
                        const currentToolGroupId = getToolGroupId();
                        if (currentToolGroupId) {
                          await segmentationService.addSegmentationRepresentationToToolGroup(
                            currentToolGroupId,
                            segmentationId
                          );
                        }
                      } catch (e) {
                        console.error('[SegmentationSync] OHIF fallback also failed:', e);
                      }
                    }
                  }
                } else {
                  console.error('[SegmentationSync] cornerstoneTools segmentation not available');
                }
              }

              // NOW copy the labelmap data AFTER all registrations are complete
              // Re-get the volume in case csTools replaced it
              console.log('[SegmentationSync] 🔍 Attempting to copy labelmap data...');
              console.log('[SegmentationSync] 🔍 segmentationVolumeId:', segmentationVolumeId);
              
              const finalSegVolume = cornerstone.cache.getVolume(segmentationVolumeId);
              console.log('[SegmentationSync] 🔍 finalSegVolume exists:', !!finalSegVolume);
              console.log('[SegmentationSync] 🔍 finalSegVolume.scalarData exists:', !!finalSegVolume?.scalarData);
              
              if (finalSegVolume?.scalarData) {
                const dims = segData.labelmapDimensions;
                let dataToApply = labelmapDataToCopy;
                
                console.log('[SegmentationSync] 📊 Dimensions from Presenter:', dims);
                console.log('[SegmentationSync] 📊 Local volume dimensions:', finalSegVolume.dimensions);
                console.log('[SegmentationSync] 📊 Source data length:', labelmapDataToCopy.length);
                console.log('[SegmentationSync] 📊 Target array length:', finalSegVolume.scalarData.length);
                console.log('[SegmentationSync] 📊 Direction from Presenter:', segData.direction);
                console.log('[SegmentationSync] 📊 Local direction:', finalSegVolume.direction ? Array.from(finalSegVolume.direction) : 'N/A');
                
                // NO FLIP - testing since base image is now correct
                // If overlay still misaligned, try v12-yflip.ts (Y only) or v12-alt-xflip.ts (X only)
                console.log('[SegmentationSync] ⚠️ Using NO FLIP');
                
                const targetArray = finalSegVolume.scalarData;
                const copyLength = Math.min(dataToApply.length, targetArray.length);
                
                // Direct copy to scalarData
                for (let i = 0; i < copyLength; i++) {
                  targetArray[i] = dataToApply[i];
                }
                
                console.log('[SegmentationSync] ✅ Copied labelmap data, length:', copyLength);
                
                // Verify some data was copied - sample multiple regions
                let nonZeroCount = 0;
                const sampleSize = 20000;
                const samplePoints = [0, Math.floor(copyLength * 0.25), Math.floor(copyLength * 0.5), Math.floor(copyLength * 0.75)];
                for (const start of samplePoints) {
                  for (let i = start; i < Math.min(start + sampleSize, copyLength); i++) {
                    if (targetArray[i] !== 0) nonZeroCount++;
                  }
                }
                console.log('[SegmentationSync] 📊 Non-zero voxels (sampled):', nonZeroCount);
              } else {
                console.error('[SegmentationSync] Could not get segmentation volume for data copy');
              }
              // Trigger render
              const vpSvc = getCornerstoneViewportService();
              const vpIds = vpSvc?.getViewportIds?.() || [];
              const renderingEngines = cornerstone.getRenderingEngines();
              if (renderingEngines?.length) {
                renderingEngines[0].renderViewports(vpIds);
                console.log('[SegmentationSync] Triggered viewport render');
              }
              
              // CRITICAL: Apply camera fix AFTER rendering to sync with Presenter
              const presenterCamera = segData.presenterCamera;
              const presenterSlice = segData.presenterSliceIndex;
              
              setTimeout(() => {
                try {
                  const vpService = getCornerstoneViewportService();
                  const viewportId = vpService?.getViewportIds?.()?.[0];
                  const re = vpService?.getRenderingEngine?.();
                  const vp = re?.getViewport(viewportId);
                  
                  if (vp && vp.type === 'orthographic') {
                    console.log('[SegmentationSync] 🔧 Applying post-render camera sync...');
                    
                    const camera = vp.getCamera?.();
                    console.log('[SegmentationSync] Current camera:', JSON.stringify(camera));
                    console.log('[SegmentationSync] Presenter camera:', JSON.stringify(presenterCamera));
                    console.log('[SegmentationSync] Presenter slice:', presenterSlice);
                    
                    // If Presenter camera is available, use it
                    if (presenterCamera && camera) {
                      const newCamera = {
                        ...camera,
                        focalPoint: presenterCamera.focalPoint || camera.focalPoint,
                        position: presenterCamera.position || camera.position,
                        parallelScale: presenterCamera.parallelScale || camera.parallelScale,
                      };
                      
                      vp.setCamera(newCamera);
                      console.log('[SegmentationSync] ✅ Applied Presenter camera');
                    } else {
                      // Fallback: Navigate to first slice using volume origin
                      const volumes = cornerstone.cache.getVolumes();
                      const refVol = volumes.find((v: any) => !v.volumeId?.includes('segmentation'));
                      
                      if (refVol && camera) {
                        const firstSliceZ = refVol.origin?.[2] || 0;
                        const deltaZ = firstSliceZ - camera.focalPoint[2];
                        
                        const newCamera = {
                          ...camera,
                          focalPoint: [camera.focalPoint[0], camera.focalPoint[1], firstSliceZ],
                          position: [camera.position[0], camera.position[1], camera.position[2] + deltaZ],
                        };
                        
                        vp.setCamera(newCamera);
                        console.log('[SegmentationSync] ✅ Moved to first slice (Z=' + firstSliceZ + ')');
                      }
                    }
                    
                    vp.render?.();
                  }
                } catch (e) {
                  console.log('[SegmentationSync] Post-render fix failed:', e);
                }
              }, 200);
              
              // Request viewport sync from Presenter after a short delay
              // This ensures the viewport position is restored after conversion
              setTimeout(() => {
                try {
                  const socket = collaborationService?.socket;
                  if (socket?.connected) {
                    socket.emit('request-viewport-sync', { sessionId });
                    console.log('[SegmentationSync] 📤 Requested viewport sync from Presenter');
                  }
                } catch (syncError) {
                  console.log('[SegmentationSync] Could not request viewport sync:', syncError);
                }
              }, 500);
              
              const perfEnd = performance.now();
              console.log(`[SegmentationSync] Successfully applied remote segmentation in ${perfEnd - perfStart}ms`);
            }
          } catch (e) {
            console.error('[SegmentationSync] Failed to apply labelmap:', e);
            throw e;
          }
        } else {
          // No labelmap data - just update metadata for existing segmentation
          const existing = segmentationService.getSegmentation(segmentationId);
          if (existing) {
            for (const segment of segData.segments) {
              try {
                segmentationService.setSegmentVisibility(
                  segmentationId,
                  segment.segmentIndex,
                  segment.isVisible
                );
              } catch (e) {
                console.warn(`[SegmentationSync] Could not set visibility for segment ${segment.segmentIndex}:`, e);
              }
            }
            console.log('[SegmentationSync] Updated existing segmentation metadata');
          } else {
            console.log('[SegmentationSync] No labelmap data and segmentation does not exist locally');
          }
        }
      } catch (e) {
        console.error('[SegmentationSync] Failed to apply remote segmentation:', e);
        throw e;
      } finally {
        pendingSegmentationsRef.current.delete(segmentationId);
        
        // Only clear the processing flag if no other operations are pending
        setTimeout(() => {
          if (pendingSegmentationsRef.current.size === 0) {
            isProcessingRemoteRef.current = false;
          }
        }, 100);
      }
    })();

    // Store the promise for this operation
    pendingPromisesRef.current.set(segmentationId, operationPromise);
    
    // Clean up after completion
    operationPromise.finally(() => {
      pendingPromisesRef.current.delete(segmentationId);
    });

    return operationPromise;
  }, [getSegmentationService, getCornerstoneViewportService, getToolGroupId, validateSegmentationSyncData, base64DecodeToUint8Array, findMatchingVolume]);

  /**
   * Check if we can broadcast
   */
  const canBroadcast = useCallback(() => {
    return (
      collaborationService?.socket?.connected &&
      !isProcessingRemoteRef.current &&
      sessionId &&
      role === 'presenter'
    );
  }, [collaborationService, sessionId, role]);

  /**
   * Debounced broadcast function
   */
  const debouncedBroadcast = useMemo(() => {
    const timeouts = new Map<string, NodeJS.Timeout>();
    
    return (segmentation: any, eventType: string) => {
      const segmentationId = segmentation?.segmentationId;
      if (!segmentationId) return;

      // Clear existing timeout for this segmentation
      if (timeouts.has(segmentationId)) {
        clearTimeout(timeouts.get(segmentationId));
      }

      // Set new timeout
      const timeout = setTimeout(() => {
        if (!canBroadcast()) {
          console.log('[SegmentationSync] Cannot broadcast, skipping');
          return;
        }

        // Throttle check
        const now = Date.now();
        const lastBroadcast = lastBroadcastTimeRef.current.get(segmentationId) || 0;
        if (now - lastBroadcast < broadcastThrottleMs) {
          console.log('[SegmentationSync] Throttled, skipping broadcast');
          return;
        }
        lastBroadcastTimeRef.current.set(segmentationId, now);

        if (pendingSegmentationsRef.current.has(segmentationId)) {
          console.log('[SegmentationSync] Segmentation pending, skipping broadcast');
          return;
        }

        const serialized = serializeSegmentation(segmentation);
        if (!serialized) {
          console.log('[SegmentationSync] Failed to serialize, skipping broadcast');
          return;
        }

        const socket = collaborationService.socket;
        if (!socket) {
          console.log('[SegmentationSync] No socket, skipping broadcast');
          return;
        }

        console.log(`[SegmentationSync] Broadcasting ${eventType}:`, serialized.segmentationId, 
          'hasLabelmapData:', !!serialized.labelmapData);
        
        socket.emit(`segmentation:${eventType}`, {
          sessionId,
          segmentation: serialized,
        });

        // Cleanup old timers periodically
        cleanupBroadcastTimers();
      }, broadcastThrottleMs);

      timeouts.set(segmentationId, timeout);
    };
  }, [canBroadcast, collaborationService, sessionId, serializeSegmentation, broadcastThrottleMs, cleanupBroadcastTimers]);

  /**
   * Broadcast segmentation to other participants
   */
  const broadcastSegmentation = useCallback((segmentation: any, eventType: string) => {
    console.log('[SegmentationSync] broadcastSegmentation called:', {
      eventType,
      segmentationId: segmentation?.segmentationId,
      hasCollabService: !!collaborationService,
      sessionId,
      isProcessingRemote: isProcessingRemoteRef.current,
      canBroadcast: canBroadcast(),
    });

    if (!canBroadcast()) {
      console.log('[SegmentationSync] Cannot broadcast, skipping');
      return;
    }

    debouncedBroadcast(segmentation, eventType);
  }, [debouncedBroadcast, canBroadcast, collaborationService]);

  /**
   * Subscribe to local segmentation events
   */
  useEffect(() => {
    if (!isEnabled || !collaborationService || !sessionId || !servicesManager) {
      return;
    }

    const segmentationService = getSegmentationService();
    if (!segmentationService) {
      console.warn('[SegmentationSync] SegmentationService not available');
      return;
    }

    console.log('[SegmentationSync] Setting up segmentation sync...');

    const events = segmentationService.EVENTS;
    const subs: Array<{ unsubscribe: () => void }> = [];

    // Handle segmentation added
    const handleSegmentationAdded = (event: any) => {
      console.log('[SegmentationSync] SEGMENTATION_ADDED event received:', event);
      
      if (isProcessingRemoteRef.current) {
        console.log('[SegmentationSync] Skipping - processing remote');
        return;
      }
      const segmentation = event?.segmentation || event;
      
      // Small delay to ensure labelmap data is ready
      setTimeout(() => {
        const fullSeg = segmentationService.getSegmentation(segmentation?.segmentationId);
        if (fullSeg) {
          broadcastSegmentation(fullSeg, 'add');
        } else {
          console.log('[SegmentationSync] Could not get full segmentation');
        }
      }, 500);
    };

    // Handle segmentation updated
    const handleSegmentationUpdated = (event: any) => {
      if (isProcessingRemoteRef.current) return;
      const segmentation = event?.segmentation || event;
      const fullSeg = segmentationService.getSegmentation(segmentation?.segmentationId);
      if (fullSeg) {
        broadcastSegmentation(fullSeg, 'update');
      }
    };

    // Handle segmentation removed
    const handleSegmentationRemoved = (event: any) => {
      if (isProcessingRemoteRef.current) return;
      const segmentationId = event?.segmentationId || event?.segmentation?.segmentationId;
      if (!segmentationId) return;

      const socket = collaborationService.socket;
      if (socket) {
        console.log('[SegmentationSync] Broadcasting segmentation removal:', segmentationId);
        socket.emit('segmentation:remove', {
          sessionId,
          segmentationId,
        });
      }
    };

    if (events) {
      console.log('[SegmentationSync] Available events:', Object.keys(events));

      if (events.SEGMENTATION_ADDED) {
        const sub = segmentationService.subscribe(events.SEGMENTATION_ADDED, handleSegmentationAdded);
        if (sub) {
          subs.push(sub);
          console.log('[SegmentationSync] ✅ Subscribed to SEGMENTATION_ADDED');
        } else {
          console.log('[SegmentationSync] ❌ Failed to subscribe to SEGMENTATION_ADDED');
        }
      }

      if (events.SEGMENTATION_UPDATED) {
        const sub = segmentationService.subscribe(events.SEGMENTATION_UPDATED, handleSegmentationUpdated);
        if (sub) {
          subs.push(sub);
          console.log('[SegmentationSync] ✅ Subscribed to SEGMENTATION_UPDATED');
        }
      }

      if (events.SEGMENTATION_REMOVED) {
        const sub = segmentationService.subscribe(events.SEGMENTATION_REMOVED, handleSegmentationRemoved);
        if (sub) {
          subs.push(sub);
          console.log('[SegmentationSync] ✅ Subscribed to SEGMENTATION_REMOVED');
        }
      }

      // Also listen for segment-level changes
      if (events.SEGMENTATION_DATA_MODIFIED) {
        const sub = segmentationService.subscribe(events.SEGMENTATION_DATA_MODIFIED, (event: any) => {
          if (isProcessingRemoteRef.current) return;
          const segmentationId = event?.segmentationId;
          if (segmentationId) {
            const fullSeg = segmentationService.getSegmentation(segmentationId);
            if (fullSeg) {
              broadcastSegmentation(fullSeg, 'update');
            }
          }
        });
        if (sub) subs.push(sub);
      }

      subscriptionsRef.current = subs;
    }

    console.log('[SegmentationSync] Segmentation sync setup complete');

    return () => {
      console.log('[SegmentationSync] Cleaning up segmentation subscriptions');
      subscriptionsRef.current.forEach(sub => {
        try { sub.unsubscribe(); } catch (e) {}
      });
      subscriptionsRef.current = [];
    };
  }, [isEnabled, collaborationService, sessionId, servicesManager, getSegmentationService, broadcastSegmentation]);

  /**
   * Subscribe to remote segmentation events
   */
  useEffect(() => {
    if (!isEnabled || !collaborationService) return;

    const socket = collaborationService.socket;
    if (!socket) return;

    const handleRemoteAdd = async (data: any) => {
      console.log('[SegmentationSync] Received remote segmentation add:', data?.segmentation?.segmentationId);
      if (data?.segmentation) {
        await applyRemoteSegmentation(data.segmentation);
      }
    };

    const handleRemoteUpdate = async (data: any) => {
      console.log('[SegmentationSync] Received remote segmentation update:', data?.segmentation?.segmentationId);
      if (data?.segmentation) {
        await applyRemoteSegmentation(data.segmentation);
      }
    };

    const handleRemoteRemove = (data: any) => {
      console.log('[SegmentationSync] Received remote segmentation remove:', data?.segmentationId);
      if (data?.segmentationId) {
        const segmentationService = getSegmentationService();
        if (segmentationService) {
          try {
            segmentationService.remove(data.segmentationId);
          } catch (e) {
            console.warn('[SegmentationSync] Could not remove segmentation:', e);
          }
        }
      }
    };

    socket.on('segmentation:added', handleRemoteAdd);
    socket.on('segmentation:updated', handleRemoteUpdate);
    socket.on('segmentation:removed', handleRemoteRemove);
    
// ===========================================================
// useSegmentationSync.ts - VIEWPORT SYNC HANDLER FIX
// ===========================================================
//
// This fix addresses:
// 1. Silent returns that swallow events
// 2. Missing debug logging
// 3. Better stack→volume index conversion
// 4. Jitter prevention with debouncing
//
// ===========================================================

    // Track last applied state to prevent jitter
    let lastAppliedIndex = -1;
    let lastAppliedZ = -999999;
    let applyTimeout: ReturnType<typeof setTimeout> | null = null;
    
    // Handle viewport sync updates for both stack and volume viewports
    // Server emits 'viewport:sync' when presenter sends 'viewport:update'
    const handleViewportSync = (data: any) => {
      // Always log raw data first
      console.log('[SegmentationSync] 📥 RAW viewport:sync received:', data);
      
      // Extract viewportState from server response
      const viewportState = data?.viewportState || data;
      
      if (!viewportState) {
        console.log('[SegmentationSync] ⚠️ Empty viewportState received');
        return;
      }
      
      console.log('[SegmentationSync] 📥 Parsed viewportState:', {
        type: viewportState.type,
        imageIndex: viewportState.imageIndex,
        hasCamera: !!viewportState.camera,
        cameraZ: viewportState.camera?.focalPoint?.[2],
      });
      
      try {
        // Get viewport via cornerstone directly
        const cornerstone = (window as any).cornerstone;
        const renderingEngines = cornerstone?.getRenderingEngines?.();
        
        if (!renderingEngines?.length) {
          console.log('[SegmentationSync] ⚠️ No rendering engines available');
          return;
        }
        
        const viewports = renderingEngines[0].getViewports?.();
        if (!viewports?.length) {
          console.log('[SegmentationSync] ⚠️ No viewports available');
          return;
        }
        
        const vp = viewports[0];
        if (!vp) {
          console.log('[SegmentationSync] ⚠️ Primary viewport is null');
          return;
        }
        
        const isVolumeViewport = vp.type === 'orthographic';
        console.log('[SegmentationSync] 📥 Local viewport type:', vp.type, 'isVolume:', isVolumeViewport);
        
        // CASE 1: Both are volume viewports - apply camera directly
        if (viewportState?.camera && isVolumeViewport && viewportState.type === 'volume') {
          const currentCamera = vp.getCamera?.();
          if (currentCamera && viewportState.camera.focalPoint) {
            const targetZ = viewportState.camera.focalPoint[2];
            const currentZ = currentCamera.focalPoint[2];
            
            // Jitter prevention: only apply if meaningful difference
            if (Math.abs(targetZ - lastAppliedZ) < 0.1) {
              console.log('[SegmentationSync] 📥 Skipping duplicate Z position');
              return;
            }
            
            console.log('[SegmentationSync] 📥 Applying camera sync (volume→volume), Z:', 
              currentZ.toFixed(1), '→', targetZ.toFixed(1));
            
            const newCamera = {
              ...currentCamera,
              focalPoint: viewportState.camera.focalPoint,
              position: viewportState.camera.position,
              parallelScale: viewportState.camera.parallelScale || currentCamera.parallelScale,
            };
            
            vp.setCamera(newCamera);
            vp.render?.();
            lastAppliedZ = targetZ;
            
            console.log('[SegmentationSync] ✅ Volume camera sync applied');
          }
          return;
        }
        
        // CASE 2: Presenter is stack, Follower is volume - convert index to Z
        if (viewportState?.imageIndex !== undefined && isVolumeViewport) {
          const targetIndex = viewportState.imageIndex;
          
          // Jitter prevention
          if (targetIndex === lastAppliedIndex) {
            console.log('[SegmentationSync] 📥 Skipping duplicate index:', targetIndex);
            return;
          }
          
          const currentCamera = vp.getCamera?.();
          if (!currentCamera) {
            console.log('[SegmentationSync] ⚠️ Cannot get current camera');
            return;
          }
          
          // Find reference volume for Z calculation
          let refVolume = null;
          
          // Method 1: Try viewport actors
          const actors = vp.getActors?.() || [];
          for (const actor of actors) {
            if (actor?.uid && !actor.uid.includes('segmentation')) {
              refVolume = cornerstone.cache.getVolume(actor.uid);
              if (refVolume) {
                console.log('[SegmentationSync] 📥 Found ref volume from actor:', actor.uid);
                break;
              }
            }
          }
          
          // Method 2: Search cache for non-segmentation volume
          if (!refVolume) {
            const volumes = cornerstone.cache?.getVolumes?.() || [];
            for (const vol of volumes) {
              if (vol?.volumeId && !vol.volumeId.includes('segmentation')) {
                refVolume = vol;
                console.log('[SegmentationSync] 📥 Found ref volume from cache:', vol.volumeId);
                break;
              }
            }
          }
          
          if (!refVolume || !refVolume.origin || !refVolume.spacing) {
            console.log('[SegmentationSync] ⚠️ Cannot convert index→Z: no reference volume found');
            console.log('[SegmentationSync] 📊 refVolume:', refVolume);
            console.log('[SegmentationSync] 📊 origin:', refVolume?.origin);
            console.log('[SegmentationSync] 📊 spacing:', refVolume?.spacing);
            return;
          }
          
          const originZ = refVolume.origin[2] || 0;
          const spacingZ = refVolume.spacing[2] || 5;
          
          // Calculate Z position for the target slice
          // Z = origin + (sliceIndex * spacing)
          const targetZ = originZ + (targetIndex * spacingZ);
          const currentZ = currentCamera.focalPoint[2];
          
          console.log('[SegmentationSync] 📥 Converting stack→volume: index', targetIndex, 
            '→ Z', targetZ.toFixed(1), '(origin:', originZ, 'spacing:', spacingZ, ')');
          
          // Only update if there's a meaningful difference (avoid jitter)
          if (Math.abs(targetZ - currentZ) < 0.5) {
            console.log('[SegmentationSync] 📥 Already at target Z, skipping');
            lastAppliedIndex = targetIndex;
            return;
          }
          
          // Debounce rapid updates to prevent jitter
          if (applyTimeout) {
            clearTimeout(applyTimeout);
          }
          
          applyTimeout = setTimeout(() => {
            try {
              const latestCamera = vp.getCamera?.();
              if (!latestCamera) return;
              
              const deltaZ = targetZ - latestCamera.focalPoint[2];
              const newCamera = {
                ...latestCamera,
                focalPoint: [latestCamera.focalPoint[0], latestCamera.focalPoint[1], targetZ],
                position: [latestCamera.position[0], latestCamera.position[1], latestCamera.position[2] + deltaZ],
              };
              
              vp.setCamera(newCamera);
              vp.render?.();
              
              lastAppliedIndex = targetIndex;
              lastAppliedZ = targetZ;
              
              console.log('[SegmentationSync] ✅ Stack→Volume sync applied: index', targetIndex, '→ Z', targetZ.toFixed(1));
            } catch (e) {
              console.log('[SegmentationSync] ⚠️ Debounced apply failed:', e);
            }
          }, 50); // 50ms debounce
          
          return;
        }
        
        // CASE 3: Both are stack viewports - apply image index directly
        if (viewportState?.imageIndex !== undefined && !isVolumeViewport) {
          const targetIndex = viewportState.imageIndex;
          const currentIndex = vp.getCurrentImageIdIndex?.() ?? -1;
          
          if (currentIndex === targetIndex) {
            console.log('[SegmentationSync] 📥 Already at target index:', targetIndex);
            return;
          }
          
          console.log('[SegmentationSync] 📥 Applying stack→stack sync, index:', currentIndex, '→', targetIndex);
          
          vp.setImageIdIndex?.(targetIndex);
          vp.render?.();
          lastAppliedIndex = targetIndex;
          
          console.log('[SegmentationSync] ✅ Stack sync applied');
          return;
        }
        
        // CASE 4: Unhandled case
        console.log('[SegmentationSync] ⚠️ Unhandled viewport sync case:', {
          presenterType: viewportState.type,
          followerType: vp.type,
          hasCamera: !!viewportState.camera,
          hasIndex: viewportState.imageIndex !== undefined,
        });
        
      } catch (e) {
        console.error('[SegmentationSync] ❌ Viewport sync handler error:', e);
      }
    };
    
    socket.on('viewport:sync', handleViewportSync);
    
    console.log('[SegmentationSync] Subscribed to remote segmentation events');

    return () => {
      socket.off('segmentation:added', handleRemoteAdd);
      socket.off('segmentation:updated', handleRemoteUpdate);
      socket.off('segmentation:removed', handleRemoteRemove);
      socket.off('viewport:sync', handleViewportSync);
    };
  }, [isEnabled, collaborationService, applyRemoteSegmentation, getSegmentationService]);

  /**
   * Set up volume viewport camera sync
   * This runs independently of CollaborationPanel and handles camera-based sync for volume viewports
   */
  useEffect(() => {
    if (!isEnabled || !collaborationService?.socket?.connected || !sessionId) return;
    
    const socket = collaborationService.socket;
    
    // Only set up camera broadcasting for presenters
    if (role !== 'presenter') {
      console.log('[SegmentationSync] 🎥 Not presenter, skipping camera broadcast setup');
      return;
    }
    
    console.log('[SegmentationSync] 🎥 Setting up viewport camera sync for presenter');
    
    let lastCameraZ = 0;
    let lastImageIndex = -1;
    let lastViewportType = '';
    let broadcastTimeout: ReturnType<typeof setTimeout> | null = null;
    
    /**
     * Get the current viewport state for broadcasting
     * This is extracted into a function so it can be reused for both polling and request-response
     */
    const getCurrentViewportState = (): { state: any; vp: any } | null => {
      try {
        const cornerstone = (window as any).cornerstone;
        const renderingEngines = cornerstone?.getRenderingEngines?.();
        if (!renderingEngines?.length) return null;
        
        const viewports = renderingEngines[0].getViewports?.();
        if (!viewports?.length) return null;
        
        const vp = viewports[0];
        if (!vp) return null;
        
        const camera = vp.getCamera?.();
        if (!camera) return null;
        
        // Check if this is a volume viewport (orthographic) or stack viewport
        const isVolumeViewport = vp.type === 'orthographic';
        
        if (isVolumeViewport) {
          return {
            state: {
              camera: {
                focalPoint: Array.from(camera.focalPoint || []),
                position: Array.from(camera.position || []),
                parallelScale: camera.parallelScale,
              },
              type: 'volume',
            },
            vp,
          };
        } else {
          return {
            state: {
              imageIndex: vp.getCurrentImageIdIndex?.() ?? 0,
              type: 'stack',
            },
            vp,
          };
        }
      } catch (e) {
        return null;
      }
    };
    
    /**
     * Force broadcast the current viewport state (used for request-response)
     */
    const forceBroadcastViewportState = () => {
      const result = getCurrentViewportState();
      if (!result) return;
      
      const { state, vp } = result;
      console.log('[SegmentationSync] 🎥 Force broadcasting viewport state, type:', state.type);
      
      socket.emit('viewport:update', {
        sessionId,
        viewportState: state,
      });
      
      // Also emit on viewport:sync for legacy compatibility
      socket.emit('viewport:sync', {
        sessionId,
        viewportState: state,
      });
    };
    
    const broadcastViewportState = () => {
      const result = getCurrentViewportState();
      if (!result) return;
      
      const { state, vp } = result;
      
      // Detect viewport type changes and force broadcast
      let forceEmit = false;
      if (lastViewportType !== state.type) {
        console.log('[SegmentationSync] 🎥 Viewport type changed from', lastViewportType, 'to', state.type);
        lastViewportType = state.type;
        // Reset tracking variables on type change
        lastCameraZ = -999999; // Use impossible value to force broadcast
        lastImageIndex = -999999;
        forceEmit = true;
      }
      
      if (state.type === 'volume') {
        // For volume viewports, track camera Z position
        const currentZ = state.camera?.focalPoint?.[2] || 0;
        if (!forceEmit && Math.abs(currentZ - lastCameraZ) < 0.1) return;
        
        lastCameraZ = currentZ;
        console.log('[SegmentationSync] 🎥 Broadcasting camera position, Z:', currentZ.toFixed(1), forceEmit ? '(forced)' : '');
      } else {
        // For stack viewports, track image index
        const currentIndex = state.imageIndex ?? -1;
        if (!forceEmit && currentIndex === lastImageIndex) return;
        
        lastImageIndex = currentIndex;
        console.log('[SegmentationSync] 🎥 Broadcasting image index:', currentIndex, forceEmit ? '(forced)' : '');
      }
      
      socket.emit('viewport:update', {
        sessionId,
        viewportState: state,
      });
      
      // Also emit on viewport:sync for Follower compatibility
      socket.emit('viewport:sync', {
        sessionId,
        viewportState: state,
      });
    };
    
    const throttledBroadcast = () => {
      if (broadcastTimeout) return;
      broadcastTimeout = setTimeout(() => {
        broadcastTimeout = null;
        broadcastViewportState();
      }, 100); // 100ms throttle
    };
    
    // Set up polling for viewport changes (works for both stack and volume)
    // Use faster polling to catch viewport type changes quickly
    const pollInterval = setInterval(throttledBroadcast, 150);
    
    // Also try to listen to cornerstone events
    const handleViewportChange = () => throttledBroadcast();
    
    let attachedElement: HTMLElement | null = null;
    let lastAttachedType = '';
    
    const attachListeners = () => {
      try {
        const cornerstone = (window as any).cornerstone;
        const renderingEngines = cornerstone?.getRenderingEngines?.();
        if (!renderingEngines?.length) return;
        
        const viewports = renderingEngines[0].getViewports?.();
        if (!viewports?.length) return;
        
        const vp = viewports[0];
        // Re-attach if element changed OR viewport type changed
        const needsReattach = vp?.element && (vp.element !== attachedElement || vp.type !== lastAttachedType);
        
        if (needsReattach) {
          // Detach from old element if any
          if (attachedElement) {
            attachedElement.removeEventListener('cornerstonecameramodified', handleViewportChange);
            attachedElement.removeEventListener('CORNERSTONE_CAMERA_MODIFIED', handleViewportChange);
            attachedElement.removeEventListener('cornerstonestackscroll', handleViewportChange);
            attachedElement.removeEventListener('CORNERSTONE_STACK_NEW_IMAGE', handleViewportChange);
            attachedElement.removeEventListener('CORNERSTONE_VOLUME_NEW_IMAGE', handleViewportChange);
          }
          
          // Attach to new element
          attachedElement = vp.element;
          lastAttachedType = vp.type;
          attachedElement.addEventListener('cornerstonecameramodified', handleViewportChange);
          attachedElement.addEventListener('CORNERSTONE_CAMERA_MODIFIED', handleViewportChange);
          attachedElement.addEventListener('cornerstonestackscroll', handleViewportChange);
          attachedElement.addEventListener('CORNERSTONE_STACK_NEW_IMAGE', handleViewportChange);
          attachedElement.addEventListener('CORNERSTONE_VOLUME_NEW_IMAGE', handleViewportChange);
          console.log('[SegmentationSync] 🎥 Attached viewport event listeners, type:', vp.type);
          
          // Force broadcast after re-attachment to ensure followers get the current state
          setTimeout(forceBroadcastViewportState, 100);
        }
      } catch (e) {
        // Silently ignore
      }
    };
    
    // Attach listeners initially and re-check frequently (to catch viewport type changes after MONAI)
    attachListeners();
    const listenerCheckInterval = setInterval(attachListeners, 500); // Check every 500ms instead of 2000ms
    
    /**
     * Handle request-viewport-sync from Followers
     * This is sent when Follower finishes applying a segmentation and needs the current Presenter position
     */
    const handleViewportSyncRequest = (data: any) => {
      console.log('[SegmentationSync] 📥 Received request-viewport-sync from Follower');
      // Immediately broadcast the current viewport state
      forceBroadcastViewportState();
    };
    
    socket.on('request-viewport-sync', handleViewportSyncRequest);
    
    return () => {
      clearInterval(pollInterval);
      clearInterval(listenerCheckInterval);
      if (broadcastTimeout) clearTimeout(broadcastTimeout);
      
      socket.off('request-viewport-sync', handleViewportSyncRequest);
      
      if (attachedElement) {
        attachedElement.removeEventListener('cornerstonecameramodified', handleViewportChange);
        attachedElement.removeEventListener('CORNERSTONE_CAMERA_MODIFIED', handleViewportChange);
        attachedElement.removeEventListener('cornerstonestackscroll', handleViewportChange);
        attachedElement.removeEventListener('CORNERSTONE_STACK_NEW_IMAGE', handleViewportChange);
        attachedElement.removeEventListener('CORNERSTONE_VOLUME_NEW_IMAGE', handleViewportChange);
      }
    };
  }, [isEnabled, collaborationService, sessionId, role]);

  /**
   * Set up periodic cleanup
   */
  useEffect(() => {
    cleanupTimerRef.current = setInterval(cleanupBroadcastTimers, BROADCAST_TIMER_CLEANUP_MS);
    
    return () => {
      if (cleanupTimerRef.current) {
        clearInterval(cleanupTimerRef.current);
        cleanupTimerRef.current = null;
      }
      
      // Clean up all pending promises
      pendingPromisesRef.current.clear();
      pendingSegmentationsRef.current.clear();
      lastBroadcastTimeRef.current.clear();
    };
  }, [cleanupBroadcastTimers]);

  return {
    broadcastSegmentation,
    applyRemoteSegmentation,
    isProcessingRemote: isProcessingRemoteRef.current,
    pendingSegmentations: Array.from(pendingSegmentationsRef.current),
    canBroadcast: canBroadcast(),
  };
}

export default useSegmentationSync;
