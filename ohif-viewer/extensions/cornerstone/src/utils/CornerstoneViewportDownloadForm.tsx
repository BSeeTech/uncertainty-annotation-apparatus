import React, { useEffect } from 'react';
import {
  Enums,
  getEnabledElement,
  getOrCreateCanvas,
  StackViewport,
  BaseVolumeViewport,
} from '@cornerstonejs/core';
import { ToolGroupManager } from '@cornerstonejs/tools';
import PropTypes from 'prop-types';
import { ViewportDownloadForm } from '@ohif/ui';

import { getEnabledElement as OHIFgetEnabledElement } from '../state';

const MINIMUM_SIZE = 100;
const DEFAULT_SIZE = 512;
const MAX_TEXTURE_SIZE = 10000;
const VIEWPORT_ID = 'cornerstone-viewport-download-form';

const getImageMimeType = fileType => {
  const normalizedFileType = Array.isArray(fileType) ? fileType[0] : fileType;
  return `image/${normalizedFileType === 'jpg' ? 'jpeg' : normalizedFileType}`;
};

const copyViewPresentation = (sourceViewport, targetViewport) => {
  const viewReference = sourceViewport.getViewReference?.();
  const presentation = sourceViewport.getViewPresentation?.();

  if (viewReference && typeof targetViewport.setViewReference === 'function') {
    targetViewport.setViewReference(viewReference);
  }
  if (presentation && typeof targetViewport.setViewPresentation === 'function') {
    targetViewport.setViewPresentation(presentation);
  }
};

const CornerstoneViewportDownloadForm = ({
  onClose,
  activeViewportId: activeViewportIdProp,
  cornerstoneViewportService,
}) => {
  const enabledElement = OHIFgetEnabledElement(activeViewportIdProp);
  const activeViewportElement = enabledElement?.element;
  const activeViewportEnabledElement = getEnabledElement(activeViewportElement);

  const { viewportId: activeViewportId, renderingEngineId } = activeViewportEnabledElement;

  const toolGroup = ToolGroupManager.getToolGroupForViewport(activeViewportId, renderingEngineId);

  const toolModeAndBindings = Object.keys(toolGroup.toolOptions).reduce((acc, toolName) => {
    const tool = toolGroup.toolOptions[toolName];
    const { mode, bindings } = tool;

    return {
      ...acc,
      [toolName]: {
        mode,
        bindings,
      },
    };
  }, {});

  useEffect(() => {
    return () => {
      Object.keys(toolModeAndBindings).forEach(toolName => {
        const { mode, bindings } = toolModeAndBindings[toolName];
        toolGroup.setToolMode(toolName, mode, { bindings });
      });
    };
  }, []);

  const enableViewport = viewportElement => {
    if (viewportElement) {
      const { renderingEngine, viewport } = getEnabledElement(activeViewportElement);

      const viewportInput = {
        viewportId: VIEWPORT_ID,
        element: viewportElement,
        type: viewport.type,
        defaultOptions: {
          background: viewport.defaultOptions.background,
          orientation: viewport.defaultOptions.orientation,
        },
      };

      renderingEngine.enableElement(viewportInput);
    }
  };

  const disableViewport = viewportElement => {
    if (viewportElement) {
      const { renderingEngine } = getEnabledElement(viewportElement);
      renderingEngine.disableElement(VIEWPORT_ID);
    }
    return Promise.resolve();
  };

  const updateViewportPreview = (downloadViewportElement, internalCanvas, fileType) =>
    new Promise(resolve => {
      const enabledElement = getEnabledElement(downloadViewportElement);

      const { viewport: downloadViewport, renderingEngine } = enabledElement;

      // Note: Since any trigger of dimensions will update the viewport,
      // we need to resize the offScreenCanvas to accommodate for the new
      // dimensions, this is due to the reason that we are using the GPU offScreenCanvas
      // to render the viewport for the downloadViewport.
      renderingEngine.resize();

      downloadViewportElement.addEventListener(
        Enums.Events.IMAGE_RENDERED,
        function updateViewport(event) {
          const enabledElement = getEnabledElement(event.target);
          const { viewport } = enabledElement;
          const { element } = viewport;

          const downloadCanvas = getOrCreateCanvas(element);

          const dataUrl = downloadCanvas.toDataURL(getImageMimeType(fileType), 1);

          let newWidth = element.offsetHeight;
          let newHeight = element.offsetWidth;

          if (newWidth > DEFAULT_SIZE || newHeight > DEFAULT_SIZE) {
            const multiplier = DEFAULT_SIZE / Math.max(newWidth, newHeight);
            newHeight *= multiplier;
            newWidth *= multiplier;
          }

          resolve({ dataUrl, width: newWidth, height: newHeight });

          downloadViewportElement.removeEventListener(Enums.Events.IMAGE_RENDERED, updateViewport);
        }
      );

      // Register the listener before rendering. Context-pool rendering can
      // complete quickly enough that registering afterwards misses the frame
      // and leaves the preview/export canvas blank.
      downloadViewport.render();
    });

  const loadImage = (activeViewportElement, viewportElement, width, height) =>
    new Promise(resolve => {
      if (activeViewportElement && viewportElement) {
        const activeViewportEnabledElement = getEnabledElement(activeViewportElement);

        if (!activeViewportEnabledElement) {
          return;
        }

        const { viewport } = activeViewportEnabledElement;

        const renderingEngine = cornerstoneViewportService.getRenderingEngine();
        const downloadViewport = renderingEngine.getViewport(VIEWPORT_ID);

        if (downloadViewport instanceof StackViewport) {
          const imageId = viewport.getCurrentImageId();
          const properties = viewport.getProperties();

          downloadViewport.setStack([imageId]).then(() => {
            try {
              downloadViewport.setProperties(properties);
              copyViewPresentation(viewport, downloadViewport);
              const newWidth = Math.min(width || image.width, MAX_TEXTURE_SIZE);
              const newHeight = Math.min(height || image.height, MAX_TEXTURE_SIZE);

              resolve({ width: newWidth, height: newHeight });
            } catch (e) {
              // Happens on clicking the cancel button
              console.warn('Unable to set properties', e);
            }
          });
        } else if (downloadViewport instanceof BaseVolumeViewport) {
          const actors = viewport.getActors();

          // Replace the complete actor set atomically. setActors resets the
          // target camera to the actor bounds before the source presentation
          // is restored. Adding actors individually leaves a newly enabled
          // volume viewport with an uninitialised camera and renders black in
          // every condition. The actor list naturally contains CT only in C0,
          // CT + AI segmentation in C1, and CT + segmentation + heatmap in C2.
          downloadViewport.setActors(actors);

          copyViewPresentation(viewport, downloadViewport);
          downloadViewport.render();

          const newWidth = Math.min(width || image.width, MAX_TEXTURE_SIZE);
          const newHeight = Math.min(height || image.height, MAX_TEXTURE_SIZE);

          resolve({ width: newWidth, height: newHeight });
        }
      }
    });

  const toggleAnnotations = (toggle, viewportElement, activeViewportElement) => {
    const activeViewportEnabledElement = getEnabledElement(activeViewportElement);

    const downloadViewportElement = getEnabledElement(viewportElement);

    const { viewportId: activeViewportId, renderingEngineId } = activeViewportEnabledElement;
    const { viewportId: downloadViewportId } = downloadViewportElement;

    if (!activeViewportEnabledElement || !downloadViewportElement) {
      return;
    }

    const toolGroup = ToolGroupManager.getToolGroupForViewport(activeViewportId, renderingEngineId);

    // add the viewport to the toolGroup
    toolGroup.addViewport(downloadViewportId, renderingEngineId);

    Object.keys(toolGroup.getToolInstances()).forEach(toolName => {
      // make all tools Enabled so that they can not be interacted with
      // in the download viewport
      if (toggle && toolName !== 'Crosshairs') {
        try {
          toolGroup.setToolEnabled(toolName);
        } catch (e) {
          console.log(e);
        }
      } else {
        toolGroup.setToolDisabled(toolName);
      }
    });
  };

  const downloadBlob = (filename, fileType, viewportElement) => {
    const file = `${filename}.${fileType}`;
    if (!viewportElement || !getEnabledElement(viewportElement)) {
      throw new Error('Download viewport is not available. Reopen Capture and try again.');
    }

    // Capture the Cornerstone output canvas directly. html2canvas cannot
    // reliably copy GPU/WebGL-backed medical-image pixels and produced blank
    // files even when the preview was correct. Segmentation and uncertainty
    // are volume actors in this canvas, so they remain in the exported image.
    const canvas = getOrCreateCanvas(viewportElement as HTMLDivElement);
    const dataUrl = canvas.toDataURL(getImageMimeType(fileType), 1.0);
    const link = document.createElement('a');
    link.download = file;
    link.href = dataUrl;
    link.click();
  };

  return (
    <ViewportDownloadForm
      onClose={onClose}
      minimumSize={MINIMUM_SIZE}
      maximumSize={MAX_TEXTURE_SIZE}
      defaultSize={DEFAULT_SIZE}
      activeViewportElement={activeViewportElement}
      enableViewport={enableViewport}
      disableViewport={disableViewport}
      updateViewportPreview={updateViewportPreview}
      loadImage={loadImage}
      toggleAnnotations={toggleAnnotations}
      downloadBlob={downloadBlob}
    />
  );
};

CornerstoneViewportDownloadForm.propTypes = {
  onClose: PropTypes.func,
  activeViewportId: PropTypes.string.isRequired,
  cornerstoneViewportService: PropTypes.shape({
    getRenderingEngine: PropTypes.func.isRequired,
  }).isRequired,
};

export default CornerstoneViewportDownloadForm;
