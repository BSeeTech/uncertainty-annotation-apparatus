import { Enums, cache } from '@cornerstonejs/core';

/**
 * Updates the viewports in preparation for rendering segmentations.
 * Evaluates each viewport to determine which need modifications,
 * then for those viewports, changes them to a volume type and ensures
 * they are ready for segmentation rendering.
 *
 * @param {Object} params - Parameters for the function.
 * @param params.viewportId - ID of the viewport to be updated.
 * @param params.loadFn - Function to load the segmentation data.
 * @param params.servicesManager - The services manager.
 * @param params.referencedDisplaySetInstanceUID - Optional UID for the referenced display set instance.
 *
 * @returns Returns true upon successful update of viewports for segmentation rendering.
 */
async function updateViewportsForSegmentationRendering({
  viewportId,
  loadFn,
  servicesManager,
  referencedDisplaySetInstanceUID,
}: {
  viewportId: string;
  loadFn: () => Promise<string>;
  servicesManager: any;
  referencedDisplaySetInstanceUID?: string;
}) {
  const { cornerstoneViewportService, segmentationService, viewportGridService } =
    servicesManager.services;

  const viewport = getTargetViewport({ viewportId, viewportGridService });
  const targetViewportId = viewport.viewportOptions.viewportId;

  referencedDisplaySetInstanceUID =
    referencedDisplaySetInstanceUID || viewport?.displaySetInstanceUIDs[0];

  const updatedViewports = getUpdatedViewportsForSegmentation({
    servicesManager,
    viewportId,
    referencedDisplaySetInstanceUID,
  });

  // create Segmentation callback which needs to be waited until
  // the volume is created (if coming from stack)
  const createSegmentationForVolume = async () => {
    const segmentationId = await loadFn();
    segmentationService.hydrateSegmentation(segmentationId);
  };

  // the reference volume that is used to draw the segmentation. so check if the
  // volume exists in the cache (the target Viewport is already a volume viewport)
  const volumeExists = Array.from(cache._volumeCache.keys()).some(volumeId =>
    volumeId.includes(referencedDisplaySetInstanceUID)
  );

  // OPTIMIZATION: If the target viewport is already a volume viewport, we can
  // skip the expensive stack→volume transition and just create the segmentation
  // directly. This prevents the viewport from being destroyed and recreated
  // every time "+ Add Segmentation" is clicked, which caused the viewport to
  // go blank (the "toggling" behavior).
  if (
    viewport.viewportOptions?.viewportType === 'volume' &&
    volumeExists
  ) {
    await createSegmentationForVolume();
    return true;
  }

  // Track whether the segmentation has been created, to avoid double creation
  // from the event listener and the fallback path.
  let segmentationCreated = false;
  const safeCreateSegmentation = async () => {
    if (segmentationCreated) {
      return;
    }
    segmentationCreated = true;
    await createSegmentationForVolume();
  };

  // -------- Path A: Event listener on the cornerstone viewport element --------
  // This is the fast path: VOLUME_VIEWPORT_NEW_VOLUME fires right after the
  // volume actors are created and before the viewport renders.
  const elementEventListeners = [];

  updatedViewports.forEach(viewportEntry => {
    viewportEntry.viewportOptions = {
      ...viewportEntry.viewportOptions,
      viewportType: 'volume',
      needsRerendering: true,
    };
    const vpId = viewportEntry.viewportId;

    let csViewport;
    try {
      csViewport = cornerstoneViewportService.getCornerstoneViewport(vpId);
    } catch (e) {
      console.warn(
        `updateViewportsForSegmentationRendering::could not get viewport ${vpId}`,
        e
      );
    }

    if (!csViewport || !csViewport.element) {
      // The cornerstone viewport isn't ready yet — this viewport will be
      // handled by the VIEWPORT_DATA_CHANGED fallback (Path B).
      return;
    }

    let prevCamera;
    try {
      prevCamera = csViewport.getCamera();
    } catch (e) {
      // Some viewport types (e.g., newly created empty viewports) may not
      // have a camera yet.
      prevCamera = null;
    }

    const createNewSegmentationWhenVolumeMounts = async evt => {
      const isTheActiveViewportVolumeMounted = evt.detail.volumeActors?.find(ac =>
        ac.uid.includes(referencedDisplaySetInstanceUID)
      );

      // Note: make sure to re-grab the viewport since it might have changed
      // during the time it took for the volume to be mounted, for instance
      // the stack viewport has been changed to a volume viewport
      let volumeViewport;
      try {
        volumeViewport = cornerstoneViewportService.getCornerstoneViewport(vpId);
        if (volumeViewport && prevCamera) {
          volumeViewport.setCamera(prevCamera);
        }
      } catch (e) {
        console.warn(
          `updateViewportsForSegmentationRendering::could not set camera on viewport ${vpId}`,
          e
        );
      }

      volumeViewport?.element?.removeEventListener(
        Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
        createNewSegmentationWhenVolumeMounts
      );

      // Remove from our tracking array so Path B cleanup also skips it
      const idx = elementEventListeners.indexOf(
        createNewSegmentationWhenVolumeMounts
      );
      if (idx !== -1) {
        elementEventListeners.splice(idx, 1);
      }

      if (!isTheActiveViewportVolumeMounted) {
        // it means it is one of those other updated viewports so just update the camera
        return;
      }

      if (vpId === targetViewportId) {
        await safeCreateSegmentation();
      }
    };

    csViewport.element.addEventListener(
      Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
      createNewSegmentationWhenVolumeMounts
    );
    elementEventListeners.push(createNewSegmentationWhenVolumeMounts);
  });

  // -------- Path B: Fallback via VIEWPORT_DATA_CHANGED service event --------
  // If the element event listener never fires (e.g., because csViewport was
  // null during Path A setup, or the event was somehow missed), we rely on
  // VIEWPORT_DATA_CHANGED which fires after setVolumesForViewport completes.
  const DATA_CHANGED = cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED;
  let dataChangedUnsub = null;

  if (!segmentationCreated) {
    dataChangedUnsub = cornerstoneViewportService.subscribe(
      DATA_CHANGED,
      ({ viewportId: changedViewportId }) => {
        if (changedViewportId === targetViewportId && !segmentationCreated) {
          // Give the viewport a microtask tick to settle, then try to create
          // the segmentation if Path A didn't already handle it.
          setTimeout(async () => {
            // Clean up element listeners since we're handling it here
            elementEventListeners.forEach(handler => {
              try {
                const csVp = cornerstoneViewportService.getCornerstoneViewport(
                  targetViewportId
                );
                csVp?.element?.removeEventListener(
                  Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
                  handler
                );
              } catch (_) {
                // element may have been replaced; ignore
              }
            });
            elementEventListeners.length = 0;

            if (dataChangedUnsub) {
              dataChangedUnsub.unsubscribe();
              dataChangedUnsub = null;
            }

            await safeCreateSegmentation();
          }, 0);
        }
      }
    );
  }

  // Set the displaySets for the viewports that require to be updated
  viewportGridService.setDisplaySetsForViewports(updatedViewports);

  // Wait a reasonable time for either Path A or Path B to complete.
  // We use a timeout to avoid hanging forever if neither path triggers.
  try {
    await Promise.race([
      // Path A/B are both async — we just need to know when the segmentation
      // is created. Since both paths call safeCreateSegmentation (which
      // guards against double-creation), we use a simple polling approach:
      (async () => {
        const maxWait = 60000; // 60 seconds max
        const pollInterval = 100;
        let waited = 0;
        while (!segmentationCreated && waited < maxWait) {
          await new Promise(r => setTimeout(r, pollInterval));
          waited += pollInterval;
        }
      })(),
    ]);
  } catch (e) {
    console.warn(
      'updateViewportsForSegmentationRendering::timeout waiting for segmentation creation',
      e
    );
  }

  // Final attempt: if segmentation still wasn't created and the viewport is
  // now a volume, try creating it directly
  if (!segmentationCreated) {
    const currentViewport = getTargetViewport({
      viewportId: targetViewportId,
      viewportGridService,
    });
    if (
      currentViewport?.viewportOptions?.viewportType === 'volume'
    ) {
      console.warn(
        'updateViewportsForSegmentationRendering::fallback: creating segmentation after timeout'
      );
      await safeCreateSegmentation();
    }
  }

  // Clean up any remaining subscriptions
  if (dataChangedUnsub) {
    dataChangedUnsub.unsubscribe();
  }
  elementEventListeners.forEach(handler => {
    try {
      const csVp = cornerstoneViewportService.getCornerstoneViewport(
        targetViewportId
      );
      csVp?.element?.removeEventListener(
        Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
        handler
      );
    } catch (_) {
      // ignore
    }
  });
  elementEventListeners.length = 0;

  return true;
}

const getTargetViewport = ({ viewportId, viewportGridService }) => {
  const { viewports, activeViewportId } = viewportGridService.getState();
  const targetViewportId = viewportId || activeViewportId;

  const viewport = viewports.get(targetViewportId);

  return viewport;
};

/**
 * Retrieves a list of viewports that require updates in preparation for segmentation rendering.
 * This function evaluates viewports based on their compatibility with the provided segmentation's
 * frame of reference UID and appends them to the updated list if they should render the segmentation.
 *
 * @param {Object} params - Parameters for the function.
 * @param params.viewportId - the ID of the viewport to be updated.
 * @param params.servicesManager - The services manager
 * @param params.referencedDisplaySetInstanceUID - Optional UID for the referenced display set instance.
 *
 * @returns {Array} Returns an array of viewports that require updates for segmentation rendering.
 */
function getUpdatedViewportsForSegmentation({
  viewportId,
  servicesManager,
  referencedDisplaySetInstanceUID,
}) {
  const { hangingProtocolService, displaySetService, segmentationService, viewportGridService } =
    servicesManager.services;

  const { viewports, isHangingProtocolLayout } = viewportGridService.getState();

  const viewport = getTargetViewport({ viewportId, viewportGridService });
  const targetViewportId = viewport.viewportOptions.viewportId;

  const displaySetInstanceUIDs = viewports.get(targetViewportId).displaySetInstanceUIDs;

  const referenceDisplaySetInstanceUID =
    referencedDisplaySetInstanceUID || displaySetInstanceUIDs[0];

  const referencedDisplaySet = displaySetService.getDisplaySetByUID(referenceDisplaySetInstanceUID);
  const segmentationFrameOfReferenceUID = referencedDisplaySet.instances[0].FrameOfReferenceUID;

  const updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
    targetViewportId,
    referenceDisplaySetInstanceUID,
    isHangingProtocolLayout
  );

  viewports.forEach((viewport, viewportId) => {
    if (
      targetViewportId === viewportId ||
      updatedViewports.find(v => v.viewportId === viewportId)
    ) {
      return;
    }

    const shouldDisplaySeg = segmentationService.shouldRenderSegmentation(
      viewport.displaySetInstanceUIDs,
      segmentationFrameOfReferenceUID
    );

    if (shouldDisplaySeg) {
      updatedViewports.push({
        viewportId,
        displaySetInstanceUIDs: viewport.displaySetInstanceUIDs,
        viewportOptions: {
          viewportType: 'volume',
          needsRerendering: true,
        },
      });
    }
  });

  return updatedViewports.filter(v => v.viewportOptions?.viewportType !== 'volume3d');
}

export {
  updateViewportsForSegmentationRendering,
  getUpdatedViewportsForSegmentation,
  getTargetViewport,
};
