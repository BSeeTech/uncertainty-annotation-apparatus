// ********************************************************************************************************
// * C:\medical-imaging-platform\ohif-viewer\modes\collaboration\src\index.tsx
// * Collaboration Mode for OHIF Viewer
// * This mode enables real-time collaborative annotation and viewing
// * Location: modes\collaboration\src
// * 
// * FIXES APPLIED:
// * 1. hangingProtocol: Changed to 'default' (not the full module path)
// * 2. Structure now mirrors working longitudinal mode exactly
// * 3. extensions: References extensionDependencies object
// * 4. ADDED: Proper viewport change subscription for sync
// * 5. FIXED: Import toolbar buttons from local file
// * 6. ADDED: MONAI Label extension for AI-assisted segmentation
// * 7. ADDED: Mode-level segmentation sync for persistent broadcasting
// * 8. FIXED: Broadcast labelmap on DATA_MODIFIED (not ADDED) when data is ready
// ********************************************************************************************************
import { hotkeys } from '@ohif/core';
import { toolbarButtons, moreTools } from './toolbarButtons';

// Mode ID
const id = 'collaboration-mode';

// Track which segmentations we've already broadcast (to send 'add' vs 'update')
const broadcastedSegmentations = new Set<string>();
const ENABLE_MODE_LEVEL_VIEWPORT_SYNC = true; // Set to false to use hook-level sync instead

// UPDATED serializeSegmentationForSync function
// Now includes direction matrix and spacing for proper orientation handling on receiver
// Replace the existing function in modes/collaboration/src/index.tsx

function serializeSegmentationForSync(segmentation: any): any {
  if (!segmentation) return null;

  try {
    const segments: any[] = [];
    
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

    // Use the correct ID property
    const segId = segmentation.segmentationId || segmentation.id;

    const syncData: any = {
      segmentationId: segId,
      label: segmentation.label || 'Segmentation',
      type: segmentation.type || 'LABELMAP',
      segments,
    };

    // Try to get labelmap data from Cornerstone cache
    try {
      const cornerstone = (window as any).cornerstone;
      if (cornerstone?.cache) {
        const representationData = segmentation.representationData;
        console.log('[Mode] representationData:', representationData);
        console.log('[Mode] LABELMAP volumeId:', representationData?.LABELMAP?.volumeId);
        
        // Try primary volumeId from representationData
        let volumeId = representationData?.LABELMAP?.volumeId;
        let volume = volumeId ? cornerstone.cache.getVolume(volumeId) : null;
        
        // Fallback: try constructing volumeId from segmentationId
        if (!volume) {
          const fallbackVolumeId = `segmentation_${segId}`;
          console.log('[Mode] Primary volumeId failed, trying fallback:', fallbackVolumeId);
          volume = cornerstone.cache.getVolume(fallbackVolumeId);
          if (volume) {
            volumeId = fallbackVolumeId;
          }
        }
        
        // Fallback 2: search cache for any segmentation volume
        if (!volume) {
          console.log('[Mode] Searching cache for segmentation volumes...');
          const cacheKeys = cornerstone.cache._volumeCache ? 
            Array.from(cornerstone.cache._volumeCache.keys()) : [];
          console.log('[Mode] Cache keys:', cacheKeys);
          
          const segVolKey = cacheKeys.find((k: string) => k.includes('segmentation'));
          if (segVolKey) {
            console.log('[Mode] Found segmentation volume in cache:', segVolKey);
            volume = cornerstone.cache.getVolume(segVolKey);
            volumeId = segVolKey;
          }
        }
        
        console.log('[Mode] Final volume lookup result:', volume ? `found (${volumeId})` : 'NOT FOUND');
        
        if (volume?.scalarData) {
          const scalarData = volume.scalarData;
          console.log('[Mode] scalarData length:', scalarData.length, 'type:', scalarData.constructor.name);
          
          // Check if data has non-zero voxels by sampling throughout the volume
          let hasData = false;
          const totalLen = scalarData.length;
          const samplePoints = [
            0,
            Math.floor(totalLen * 0.25),
            Math.floor(totalLen * 0.5),
            Math.floor(totalLen * 0.75),
            totalLen - 10000
          ];
          
          for (const startIdx of samplePoints) {
            const endIdx = Math.min(startIdx + 20000, totalLen);
            for (let i = startIdx; i < endIdx; i++) {
              if (scalarData[i] !== 0) {
                hasData = true;
                console.log(`[Mode] Found non-zero data at index ${i} (sample region starting at ${startIdx})`);
                break;
              }
            }
            if (hasData) break;
          }
          
          if (!hasData) {
            console.log('[Mode] Labelmap has no data yet (sampled multiple regions), skipping serialization');
            return null;
          }
          
          // Get the underlying ArrayBuffer
          let uint8Array: Uint8Array;
          if (scalarData instanceof Uint8Array) {
            uint8Array = scalarData;
          } else if (scalarData.buffer) {
            uint8Array = new Uint8Array(scalarData.buffer);
          } else {
            console.warn('[Mode] Cannot convert scalarData to Uint8Array');
            return syncData;
          }
          
          // Only sync if < 20MB
          if (uint8Array.length < 20 * 1024 * 1024) {
            // Count non-zero for logging
            let nonZeroCount = 0;
            for (let i = 0; i < uint8Array.length; i++) {
              if (uint8Array[i] !== 0) nonZeroCount++;
            }
            
            // Convert to base64 in chunks
            const CHUNK_SIZE = 8192;
            let base64 = '';
            for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
              const chunk = uint8Array.subarray(i, Math.min(i + CHUNK_SIZE, uint8Array.length));
              base64 += String.fromCharCode.apply(null, Array.from(chunk));
            }
            base64 = btoa(base64);
            
            syncData.labelmapData = base64;
            syncData.labelmapDimensions = volume.dimensions;
            syncData.referencedVolumeId = volumeId;
            
            // CRITICAL: Include direction matrix and spacing for proper orientation
            // This allows the receiver to detect orientation mismatches and transform data
            if (volume.direction) {
              syncData.direction = Array.from(volume.direction);
              console.log('[Mode] Including direction matrix:', syncData.direction);
            }
            if (volume.spacing) {
              syncData.spacing = Array.from(volume.spacing);
            }
            if (volume.origin) {
              syncData.origin = Array.from(volume.origin);
            }
            
            // Include SeriesInstanceUID for cross-client volume matching
            if (volume.metadata?.SeriesInstanceUID) {
              syncData.referencedSeriesUID = volume.metadata.SeriesInstanceUID;
            } else if (volume.imageIds?.length > 0) {
              const imageId = volume.imageIds[0];
              const seriesMatch = imageId.match(/seriesUID=([^&]+)/) || 
                                 imageId.match(/series\/([^/]+)/);
              if (seriesMatch) {
                syncData.referencedSeriesUID = seriesMatch[1];
              }
            }
            
            // Include Presenter's current camera state so Follower can sync position
            try {
              console.log('[Mode] 🎥 Attempting to capture Presenter camera...');
              
              // Get viewport via cornerstone directly (more reliable than servicesManager path)
              const cornerstone = (window as any).cornerstone;
              const renderingEngines = cornerstone?.getRenderingEngines?.();
              console.log('[Mode] 🎥 renderingEngines:', renderingEngines?.length);
              
              if (renderingEngines?.length > 0) {
                const viewports = renderingEngines[0].getViewports?.();
                console.log('[Mode] 🎥 viewports:', viewports?.length);
                
                if (viewports?.length > 0) {
                  const viewport = viewports[0];
                  console.log('[Mode] 🎥 viewport type:', viewport?.type);
                  
                  const camera = viewport?.getCamera?.();
                  console.log('[Mode] 🎥 camera exists:', !!camera);
                  
                  if (camera) {
                    syncData.presenterCamera = {
                      focalPoint: Array.from(camera.focalPoint || []),
                      position: Array.from(camera.position || []),
                      viewUp: Array.from(camera.viewUp || []),
                      viewPlaneNormal: Array.from(camera.viewPlaneNormal || []),
                      parallelScale: camera.parallelScale,
                    };
                    console.log('[Mode] ✅ Including Presenter camera:', syncData.presenterCamera);
                  }
                  
                  // Also try to get current slice index
                  if (viewport.getCurrentImageIdIndex) {
                    syncData.presenterSliceIndex = viewport.getCurrentImageIdIndex();
                    console.log('[Mode] ✅ Including Presenter slice:', syncData.presenterSliceIndex);
                  }
                }
              } else {
                console.log('[Mode] ⚠️ No rendering engines found');
              }
            } catch (camError) {
              console.log('[Mode] ❌ Could not capture camera state:', camError);
            }
            
            console.log('[Mode] Serialized labelmap data, size:', uint8Array.length, 
              'base64 length:', base64.length,
              'non-zero voxels:', nonZeroCount,
              'dimensions:', syncData.labelmapDimensions,
              'seriesUID:', syncData.referencedSeriesUID || 'not found');
          } else {
            console.warn('[Mode] Labelmap too large for sync:', uint8Array.length);
          }
        }
      }
    } catch (e) {
      console.warn('[Mode] Could not serialize labelmap data:', e);
    }

    return syncData;
  } catch (e) {
    console.error('[Mode] Failed to serialize segmentation:', e);
    return null;
  }
}

// OHIF standard components - these are full module entry IDs
const ohif = {
  layout: '@ohif/extension-default.layoutTemplateModule.viewerLayout',
  sopClassHandler: '@ohif/extension-default.sopClassHandlerModule.stack',
};

// Cornerstone tracked viewport (same as longitudinal)
const tracked = {
  measurements: '@ohif/extension-measurement-tracking.panelModule.trackedMeasurements',
  thumbnailList: '@ohif/extension-measurement-tracking.panelModule.seriesList',
  viewport: '@ohif/extension-measurement-tracking.viewportModule.cornerstone-tracked',
};

// Segmentation extension (required for MONAI Label)
const segmentation = {
  panel: '@ohif/extension-cornerstone-dicom-seg.panelModule.panelSegmentation',
  panelTool: '@ohif/extension-cornerstone-dicom-seg.panelModule.panelSegmentationWithTools',
  sopClassHandler: '@ohif/extension-cornerstone-dicom-seg.sopClassHandlerModule.dicom-seg',
  viewport: '@ohif/extension-cornerstone-dicom-seg.viewportModule.dicom-seg',
};

// Collaboration extension panel
const collaboration = {
  panel: 'collaboration.panelModule.collaboration',
};

// MONAI Label extension (for AI-assisted segmentation)
const monaiLabel = {
  panel: '@ohif/extension-monai-label.panelModule.monailabel',
};

// Extension dependencies - defined once, used in both places
const extensionDependencies = {
  '@ohif/extension-default': '^3.0.0',
  '@ohif/extension-cornerstone': '^3.0.0',
  '@ohif/extension-measurement-tracking': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-sr': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-seg': '^3.0.0',
  '@ohif/extension-monai-label': '^3.0.0',
  'collaboration': '^0.1.0',
};

// Store cleanup functions
let modeCleanupFunctions: (() => void)[] = [];

function modeFactory({ modeConfiguration }) {
  return {
    id,
    routeName: 'collaboration',
    displayName: 'Collaboration',

    /**
     * ==========================================
     * Lifecycle Hooks
     * ==========================================
     */
    onModeEnter: ({ servicesManager, extensionManager, commandsManager }) => {
      console.log('🚀 Entering Collaboration Mode');
      
      // Clear broadcast tracking on mode enter
      broadcastedSegmentations.clear();
      
      const { 
        measurementService, 
        toolGroupService,
        toolbarService,
        cornerstoneViewportService,
        viewportGridService,
        segmentationService,
        customizationService,
      } = servicesManager.services;
      
      // Clear any existing measurements when entering mode
      if (measurementService) {
        measurementService.clearMeasurements();
      }

      // Configure segmentation panel (same as Basic Viewer)
      if (customizationService) {
        customizationService.addModeCustomizations([
          {
            id: 'segmentation.panel',
            disableEditing: false, // Allow editing for collaboration
          },
        ]);
      }

      // Get toolbar buttons from the cornerstone extension (same as longitudinal does)
      const utilityModule = extensionManager.getModuleEntry(
        '@ohif/extension-cornerstone.utilityModule.tools'
      );

      const { toolNames, Enums } = utilityModule.exports;

      // Debug: Log available tool names
      console.log('📋 Available toolNames:', Object.keys(toolNames || {}));
      console.log('📋 SegmentationDisplay toolName:', toolNames?.SegmentationDisplay);

      // Ensure cornerstone tools is available
      const cornerstoneTools = (window as any).cornerstoneTools;
      
      // Init default and SR tool groups (same as longitudinal)
      toolGroupService.createToolGroupAndAddTools('default', {
        tools: {
          active: [
            {
              toolName: toolNames.WindowLevel,
              bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
            },
            {
              toolName: toolNames.Pan,
              bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }],
            },
            {
              toolName: toolNames.Zoom,
              bindings: [{ mouseButton: Enums.MouseBindings.Secondary }],
            },
            { toolName: toolNames.StackScrollMouseWheel, bindings: [] },
          ],
          passive: [
            { toolName: toolNames.Length },
            { toolName: toolNames.ArrowAnnotate },
            { toolName: toolNames.Bidirectional },
            { toolName: toolNames.DragProbe },
            { toolName: toolNames.EllipticalROI },
            { toolName: toolNames.CircleROI },
            { toolName: toolNames.RectangleROI },
            { toolName: toolNames.StackScroll },
            { toolName: toolNames.Angle },
            { toolName: toolNames.CobbAngle },
            { toolName: toolNames.PlanarFreehandROI },
            { toolName: toolNames.Magnify },
            { toolName: toolNames.SegmentationDisplay },
            // Brush tools for segmentation
            { toolName: toolNames.CircularBrush },
            { toolName: toolNames.SphereBrush },
            { toolName: toolNames.CircularEraser },
            { toolName: toolNames.SphereEraser },
            { toolName: toolNames.ThresholdCircularBrush },
          ],
          enabled: [
            { toolName: toolNames.ImageOverlayViewer },
          ],
        },
        toolOptions: {
          [toolNames.ArrowAnnotate]: {
            getTextCallback: (callback) =>
              commandsManager.runCommand('arrowTextCallback', { callback }),
          },
        },
      });

      // CRITICAL: Explicitly enable SegmentationDisplayTool on the default toolGroup
      // This ensures segmentations can be rendered
      // Use setTimeout to ensure toolGroup is fully initialized
      setTimeout(() => {
        try {
          const csTools = (window as any).cornerstoneTools;
          
          // List all available toolGroups
          const allToolGroups = csTools?.ToolGroupManager?.getAllToolGroups?.() || [];
          console.log('🔧 All available toolGroups:', allToolGroups.map((tg: any) => tg.id));
          
          // Try each toolGroup
          for (const tg of allToolGroups) {
            console.log(`🔧 ToolGroup "${tg.id}" tools:`, Object.keys(tg._toolInstances || {}));
            
            // Check if SegmentationDisplay is already there
            if (!tg._toolInstances?.['SegmentationDisplay']) {
              try {
                tg.addTool('SegmentationDisplay');
                console.log(`✅ Added SegmentationDisplay to toolGroup "${tg.id}"`);
              } catch (e: any) {
                console.log(`⚠️ Could not add to "${tg.id}": ${e?.message}`);
              }
            }
            
            // Enable it
            try {
              tg.setToolEnabled?.('SegmentationDisplay');
              console.log(`✅ Enabled SegmentationDisplay on "${tg.id}"`);
            } catch (e: any) {
              console.log(`⚠️ Could not enable on "${tg.id}": ${e?.message}`);
            }
          }
          
          // Also try the default toolGroup by name
          const defaultToolGroup = csTools?.ToolGroupManager?.getToolGroup('default');
          if (defaultToolGroup && !allToolGroups.includes(defaultToolGroup)) {
            console.log('🔧 Found separate "default" toolGroup');
            try {
              defaultToolGroup.addTool('SegmentationDisplay');
              defaultToolGroup.setToolEnabled?.('SegmentationDisplay');
              console.log('✅ Added and enabled SegmentationDisplay on default');
            } catch (e: any) {
              console.log(`⚠️ Default toolGroup error: ${e?.message}`);
            }
          }
        } catch (segToolError) {
          console.warn('Could not setup SegmentationDisplay tool:', segToolError);
        }
      }, 500);  // 500ms delay to ensure toolGroup is ready

      // Create SR tool group for structured reports
      toolGroupService.createToolGroupAndAddTools('SRToolGroup', {
        tools: {
          active: [
            {
              toolName: toolNames.WindowLevel,
              bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
            },
            {
              toolName: toolNames.Pan,
              bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }],
            },
            {
              toolName: toolNames.Zoom,
              bindings: [{ mouseButton: Enums.MouseBindings.Secondary }],
            },
            { toolName: toolNames.StackScrollMouseWheel, bindings: [] },
          ],
        },
      });

      // ==========================================
      // SEGMENTATION SYNC SETUP
      // ==========================================
      try {
        const csUtils = extensionManager.getModuleEntry(
          '@ohif/extension-cornerstone.utilityModule.common'
        );
        
        if (csUtils?.exports?.getEnabledElement) {
          console.log('✅ Cornerstone utilities available for segmentation');
        }

        // Ensure segmentation service is ready
        if (segmentationService) {
          console.log('✅ SegmentationService available');
          
          // Subscribe to segmentation events for collaboration sync
          // This runs at the mode level so it persists even when panel tabs change
          const events = segmentationService.EVENTS;
          
          // On SEGMENTATION_ADDED - just log, don't broadcast (data not ready yet)
          if (events?.SEGMENTATION_ADDED) {
            const sub = segmentationService.subscribe(events.SEGMENTATION_ADDED, (evt) => {
              console.log('🎯 Segmentation added (metadata only, waiting for data):', evt);
              // Don't broadcast here - labelmap data is not populated yet
              // The actual data will be broadcast on SEGMENTATION_DATA_MODIFIED
            });
            modeCleanupFunctions.push(() => sub?.unsubscribe?.());
          }

          // On SEGMENTATION_DATA_MODIFIED - broadcast the actual data
          // Handle segmentation data modifications (e.g., after MONAI Label inference)
          if (events.SEGMENTATION_DATA_MODIFIED) {
            const dataSub = segmentationService.subscribe(
              events.SEGMENTATION_DATA_MODIFIED,
              (event: any) => {
                console.log('🔄 Segmentation data modified:', event);
                
                // Get collaboration service
                const collaborationService = servicesManager.services.collaborationService;
                const socket = collaborationService?.socket;
                const sessionId = collaborationService?.getSessionId?.();
                const role = collaborationService?.getRole?.();
                
                console.log('🔍 [Mode] Socket check:', !!socket?.connected, 'SessionId:', sessionId, 'Role:', role);
                
                // Only broadcast if we're a presenter in an active session
                if (!socket?.connected || !sessionId || role !== 'presenter') {
                  console.log('🔍 [Mode] Not broadcasting: not presenter or no session');
                  return;
                }
                
                const segmentationId = event?.segmentation?.segmentationId || 
                                       event?.segmentation?.id ||
                                       event?.segmentationId;
                console.log('🔍 [Mode] Extracted segmentationId:', segmentationId);
                
                if (!segmentationId) {
                  console.log('🔍 [Mode] No segmentationId found, skipping');
                  return;
                }
                
                // Get full segmentation data
                const fullSegmentation = segmentationService.getSegmentation(segmentationId);
                
                if (!fullSegmentation) {
                  console.log('🔍 [Mode] Could not get full segmentation');
                  return;
                }
                
                // Serialize with labelmap data
                const syncData = serializeSegmentationForSync(fullSegmentation);
                
                if (!syncData) {
                  console.log('🔍 [Mode] Serialization returned null (no data yet?)');
                  return;
                }
                
                // Determine if this is first broadcast (add) or update
                const eventType = broadcastedSegmentations.has(segmentationId) ? 'update' : 'add';
                broadcastedSegmentations.add(segmentationId);
                
                console.log(`📤 [Mode] Broadcasting segmentation:${eventType}`, {
                  segmentationId: syncData.segmentationId,
                  hasLabelmapData: !!syncData.labelmapData,
                  dimensions: syncData.labelmapDimensions,
                  hasCamera: !!syncData.presenterCamera,
                });
                
                socket.emit(`segmentation:${eventType}`, {
                  sessionId,
                  segmentation: syncData,
                });
                
                console.log(`📤 [Mode] Segmentation broadcast sent (${eventType}), hasLabelmapData=${!!syncData.labelmapData}`);
              }
            );
            
            if (dataSub) {
              modeCleanupFunctions.push(() => dataSub.unsubscribe());
              console.log('✅ [Mode] Subscribed to SEGMENTATION_DATA_MODIFIED');
            }
          } // Closing the if (events.SEGMENTATION_DATA_MODIFIED) block
        } // Closing the if (segmentationService) block
      } catch (error) {
        console.error('Error in segmentation sync setup:', error);
      } // Closing the try-catch block

      // Mode-level viewport sync for presenters
      // This runs independently of the hook and provides reliable sync
      if (ENABLE_MODE_LEVEL_VIEWPORT_SYNC) {
        let viewportPollInterval: NodeJS.Timeout | null = null;
        let lastBroadcastedIndex = -1;
        let lastBroadcastedZ = -999999;
        let lastViewportType = '';
        
        const startViewportPolling = () => {
          const collaborationService = servicesManager.services.collaborationService;
          
          if (viewportPollInterval) {
            clearInterval(viewportPollInterval);
          }
          
          viewportPollInterval = setInterval(() => {
            try {
              const socket = collaborationService?.socket;
              const sessionId = collaborationService?.getSessionId?.();
              const role = collaborationService?.getRole?.();
              
              // Only presenters broadcast
              if (!socket?.connected || !sessionId || role !== 'presenter') {
                return;
              }
              
              const cornerstone = (window as any).cornerstone;
              const renderingEngines = cornerstone?.getRenderingEngines?.();
              if (!renderingEngines?.length) return;
              
              const viewports = renderingEngines[0].getViewports?.();
              if (!viewports?.length) return;
              
              const vp = viewports[0];
              if (!vp) return;
              
              const isVolumeViewport = vp.type === 'orthographic';
              const currentType = isVolumeViewport ? 'volume' : 'stack';
              
              // Force broadcast on type change
              let forceEmit = false;
              if (currentType !== lastViewportType) {
                console.log('[Mode] 🎥 Viewport type changed:', lastViewportType, '→', currentType);
                lastViewportType = currentType;
                lastBroadcastedIndex = -999999;
                lastBroadcastedZ = -999999;
                forceEmit = true;
              }
              
              if (isVolumeViewport) {
                // Volume viewport - broadcast camera
                const camera = vp.getCamera?.();
                if (!camera) return;
                
                const currentZ = camera.focalPoint?.[2] || 0;
                
                if (!forceEmit && Math.abs(currentZ - lastBroadcastedZ) < 0.1) {
                  return; // No meaningful change
                }
                
                lastBroadcastedZ = currentZ;
                
                const viewportState = {
                  type: 'volume',
                  camera: {
                    focalPoint: Array.from(camera.focalPoint || []),
                    position: Array.from(camera.position || []),
                    parallelScale: camera.parallelScale,
                  },
                };
                
                socket.emit('viewport:update', { sessionId, viewportState });
                
              } else {
                // Stack viewport - broadcast image index
                const currentIndex = vp.getCurrentImageIdIndex?.() ?? -1;
                
                if (!forceEmit && currentIndex === lastBroadcastedIndex) {
                  return; // No change
                }
                
                lastBroadcastedIndex = currentIndex;
                
                const viewportState = {
                  type: 'stack',
                  imageIndex: currentIndex,
                };
                
                socket.emit('viewport:update', { sessionId, viewportState });
              }
              
            } catch (e) {
              // Silent fail for polling
            }
          }, 100); // 100ms polling interval
          
          console.log('[Mode] 🎥 Started viewport polling (100ms interval)');
        };
        
        // Start polling after a short delay to ensure services are ready
        setTimeout(startViewportPolling, 1000);
        
        // Cleanup
        modeCleanupFunctions.push(() => {
          if (viewportPollInterval) {
            clearInterval(viewportPollInterval);
            viewportPollInterval = null;
            console.log('[Mode] 🎥 Stopped viewport polling');
          }
        });
        
        // Listen for request-viewport-sync from followers
        const collaborationService = servicesManager.services.collaborationService;
        const socket = collaborationService?.socket;
        
        if (socket) {
          const handleViewportSyncRequest = (data: any) => {
            console.log('[Mode] 📥 Received request-viewport-sync from Follower:', data?.requesterId);
            
            // Force broadcast current state immediately
            try {
              const sessionId = collaborationService?.getSessionId?.();
              const role = collaborationService?.getRole?.();
              
              if (role !== 'presenter' || !sessionId) {
                return;
              }
              
              const cornerstone = (window as any).cornerstone;
              const renderingEngines = cornerstone?.getRenderingEngines?.();
              if (!renderingEngines?.length) return;
              
              const viewports = renderingEngines[0].getViewports?.();
              if (!viewports?.length) return;
              
              const vp = viewports[0];
              if (!vp) return;
              
              const isVolumeViewport = vp.type === 'orthographic';
              
              let viewportState: any;
              
              if (isVolumeViewport) {
                const camera = vp.getCamera?.();
                viewportState = {
                  type: 'volume',
                  camera: {
                    focalPoint: Array.from(camera?.focalPoint || []),
                    position: Array.from(camera?.position || []),
                    parallelScale: camera?.parallelScale,
                  },
                };
              } else {
                viewportState = {
                  type: 'stack',
                  imageIndex: vp.getCurrentImageIdIndex?.() ?? 0,
                };
              }
              
              console.log('[Mode] 📤 Force broadcasting viewport state:', viewportState);
              socket.emit('viewport:update', { sessionId, viewportState });
              socket.emit('viewport:sync', { sessionId, viewportState }); // Also emit directly for legacy
              
            } catch (e) {
              console.log('[Mode] ⚠️ Force broadcast failed:', e);
            }
          };
          
          socket.on('request-viewport-sync', handleViewportSyncRequest);
          
          modeCleanupFunctions.push(() => {
            socket.off('request-viewport-sync', handleViewportSyncRequest);
          });
          
          console.log('[Mode] 🎥 Listening for request-viewport-sync');
        }
      }

      // ==========================================
      // TOOLBAR SETUP - Add buttons from local file
      // ==========================================
      toolbarService.addButtons([...toolbarButtons, ...moreTools]);
      toolbarService.createButtonSection('primary', [
        'MeasurementTools',
        'Zoom',
        'WindowLevel',
        'Pan',
        'Capture',
        'Layout',
        'Crosshairs',
        'MoreTools',
      ]);
    },

    onModeExit: ({ servicesManager }) => {
      console.log('👋 Exiting Collaboration Mode');
      
      // Clear broadcast tracking
      broadcastedSegmentations.clear();
      
      const {
        toolGroupService,
        syncGroupService,
        segmentationService,
        cornerstoneViewportService,
        toolbarService,
      } = servicesManager.services;

      // Run all cleanup functions
      modeCleanupFunctions.forEach(cleanup => {
        try {
          cleanup();
        } catch (e) {
          console.warn('Cleanup error:', e);
        }
      });
      modeCleanupFunctions = [];

      toolGroupService?.destroy();
      syncGroupService?.destroy();

      // Clear segmentations
      segmentationService?.clearSegmentations?.();
    },

    /**
     * ==========================================
     * Viewport Data Sources Configuration
     * ==========================================
     */
    validationTags: {
      study: [],
      series: [],
    },

    isValidMode: ({ modalities }) => {
      if (!modalities) {
        return { valid: true };
      }

      const modalities_list = typeof modalities === 'string' 
        ? modalities.split('\\') 
        : modalities;

      // Exclude non-image modalities
      const NON_IMAGE_MODALITIES = ['SM', 'ECG', 'SR', 'SEG', 'RTSTRUCT'];
      
      const valid = Array.isArray(modalities_list) 
        ? modalities_list.some(modality => !NON_IMAGE_MODALITIES.includes(modality))
        : true;

      return {
        valid,
        description: valid 
          ? 'Collaboration mode supports this study'
          : 'Study contains only non-image modalities',
      };
    },

    /**
     * ==========================================
     * Display Set Selectors
     * ==========================================
     */
    displaySetSelectors: {
      defaultDisplaySetSelector: {
        seriesMatchingRules: [],
      },
    },

    /**
     * ==========================================
     * Toolbar Configuration
     * ==========================================
     */
    defaultContext: 'ACTIVE_VIEWPORT::CORNERSTONE',
    
    // Toolbar is set up in onModeEnter using imported buttons
    getToolbarModule: () => {
      return {
        toolbarButtons,
        moreTools,
      };
    },

    /**
     * ==========================================
     * Routes Configuration
     * ==========================================
     */
    routes: [
      {
        path: 'collaboration',
        layoutTemplate: () => {
          return {
            id: ohif.layout,
            props: {
              leftPanels: [tracked.thumbnailList],
              rightPanels: [
                collaboration.panel,
                monaiLabel.panel,
                segmentation.panel,
                tracked.measurements,
              ],
              rightPanelClosed: false,
              viewports: [
                {
                  namespace: tracked.viewport,
                  displaySetsToDisplay: [ohif.sopClassHandler],
                },
                {
                  namespace: segmentation.viewport,
                  displaySetsToDisplay: [segmentation.sopClassHandler],
                },
              ],
            },
          };
        },
      },
    ],

    /**
     * ==========================================
     * Extensions
     * ==========================================
     * CRITICAL: Must reference extensionDependencies object
     */
    extensions: extensionDependencies,

    /**
     * ==========================================
     * Hanging Protocol
     * ==========================================
     * FIXED: Use 'default' instead of full module path
     * The default protocol is self-registered by OHIF
     */
    hangingProtocol: 'default',

    /**
     * ==========================================
     * SOP Class Handlers
     * ==========================================
     * Order matters - segmentation handler must come before the default handler
     */
    sopClassHandlers: [segmentation.sopClassHandler, ohif.sopClassHandler],

    /**
     * ==========================================
     * Hotkeys
     * ==========================================
     */
    hotkeys: [...hotkeys.defaults.hotkeyBindings],

    /**
     * ==========================================
     * Spread any additional mode configuration
     * ==========================================
     */
    ...modeConfiguration,
  };
}

/**
 * Setup viewport change broadcasting for presenters
 * This ensures viewport changes are captured and sent to followers
 */
function setupViewportBroadcasting(servicesManager: any, collaborationService: any): void {
  const { cornerstoneViewportService, viewportGridService } = servicesManager.services;
  
  if (!cornerstoneViewportService || !viewportGridService) {
    console.warn('[collaboration-mode] Required services not available for viewport broadcasting');
    return;
  }

  // Subscribe to viewport grid changes
  const unsubscribeGrid = viewportGridService.subscribe(
    viewportGridService.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED || 'ACTIVE_VIEWPORT_ID_CHANGED',
    ({ viewportId }: { viewportId: string }) => {
      console.log('[collaboration-mode] Active viewport changed:', viewportId);
      // Could broadcast this to sync which viewport is being viewed
    }
  );

  if (unsubscribeGrid) {
    modeCleanupFunctions.push(unsubscribeGrid);
  }

  // Subscribe to rendering engine events for camera changes
  try {
    const renderingEngine = cornerstoneViewportService.getRenderingEngine?.();
    
    if (renderingEngine) {
      const viewportIds = renderingEngine.getViewports().map((vp: any) => vp.id);
      
      viewportIds.forEach((viewportId: string) => {
        const viewport = renderingEngine.getViewport(viewportId);
        if (viewport?.element) {
          const element = viewport.element;
          
          // Throttled broadcast function
          let broadcastTimeout: NodeJS.Timeout | null = null;
          
          const handleCameraModified = () => {
            // Only broadcast if presenter
            if (collaborationService.getRole?.() !== 'presenter') {
              return;
            }
            
            // Throttle broadcasts
            if (broadcastTimeout) {
              return;
            }
            
            broadcastTimeout = setTimeout(() => {
              broadcastTimeout = null;
              
              try {
                const camera = viewport.getCamera();
                const zoom = viewport.getZoom();
                const pan = viewport.getPan();
                const properties = viewport.getProperties();
                
                const voiRange = properties?.voiRange;
                let voi = undefined;
                if (voiRange) {
                  const windowWidth = voiRange.upper - voiRange.lower;
                  const windowCenter = voiRange.lower + windowWidth / 2;
                  voi = { windowWidth, windowCenter };
                }

                // Get current image index for stack viewports
                let imageIndex = undefined;
                if (viewport.type === 'stack') {
                  imageIndex = viewport.getCurrentImageIdIndex?.();
                }
                
                collaborationService.broadcastViewportUpdate({
                  viewportId,
                  renderingEngineId: renderingEngine.id,
                  camera: camera ? {
                    position: camera.position,
                    focalPoint: camera.focalPoint,
                    viewUp: camera.viewUp,
                    parallelScale: camera.parallelScale,
                  } : undefined,
                  zoom,
                  pan,
                  voi,
                  imageIndex,
                  timestamp: Date.now(),
                });
              } catch (e) {
                console.warn('[collaboration-mode] Error broadcasting viewport state:', e);
              }
            }, 50); // 50ms throttle
          };

          // Listen for camera changes
          element.addEventListener('cornerstonecameramodified', handleCameraModified);
          element.addEventListener('CORNERSTONE_CAMERA_MODIFIED', handleCameraModified);
          
          // Listen for VOI changes  
          element.addEventListener('cornerstonevoimodified', handleCameraModified);
          element.addEventListener('CORNERSTONE_VOI_MODIFIED', handleCameraModified);
          
          // Listen for stack scroll
          element.addEventListener('cornerstonestackscroll', handleCameraModified);
          element.addEventListener('CORNERSTONE_STACK_SCROLL', handleCameraModified);

          // Cleanup
          modeCleanupFunctions.push(() => {
            if (broadcastTimeout) {
              clearTimeout(broadcastTimeout);
            }
            element.removeEventListener('cornerstonecameramodified', handleCameraModified);
            element.removeEventListener('CORNERSTONE_CAMERA_MODIFIED', handleCameraModified);
            element.removeEventListener('cornerstonevoimodified', handleCameraModified);
            element.removeEventListener('CORNERSTONE_VOI_MODIFIED', handleCameraModified);
            element.removeEventListener('cornerstonestackscroll', handleCameraModified);
            element.removeEventListener('CORNERSTONE_STACK_SCROLL', handleCameraModified);
          });

          console.log(`[collaboration-mode] Viewport ${viewportId} broadcasting setup complete`);
        }
      });
    }
  } catch (e) {
    console.warn('[collaboration-mode] Could not setup viewport broadcasting:', e);
  }
}

/**
 * Mode export
 */
const mode = {
  id,
  modeFactory,
  extensionDependencies,
};

export default mode;
