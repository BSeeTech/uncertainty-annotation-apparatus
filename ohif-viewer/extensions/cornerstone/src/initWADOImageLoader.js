import { volumeLoader } from '@cornerstonejs/core';
import {
  cornerstoneStreamingImageVolumeLoader,
  cornerstoneStreamingDynamicImageVolumeLoader,
} from '@cornerstonejs/core/loaders';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import { errorHandler, utils } from '@ohif/core';

const { registerVolumeLoader } = volumeLoader;

export default function initWADOImageLoader(
  userAuthenticationService,
  appConfig,
  extensionManager
) {
  const config = {
    maxWebWorkers: Math.min(
      Math.max(navigator.hardwareConcurrency - 1, 1),
      appConfig.maxNumberOfWebWorkers
    ),
    startWebWorkersOnDemand: true,
    taskConfiguration: {
      decodeTask: {
        initializeCodecsOnStartup: false,
        usePDFJS: false,
        strict: false,
      },
    },
    decodeConfig: {
      convertFloatPixelDataToInt: false,
      use16BitDataType:
        Boolean(appConfig.useNorm16Texture) || Boolean(appConfig.preferSizeOverAccuracy),
    },
    beforeSend: function (xhr) {
      const sourceConfig = extensionManager.getActiveDataSource()?.[0].getConfig() ?? {};
      const headers = userAuthenticationService.getAuthorizationHeader();
      const acceptHeader = utils.generateAcceptHeader(
        sourceConfig.acceptHeader,
        sourceConfig.requestTransferSyntaxUID,
        sourceConfig.omitQuotationForMultipartRequest
      );

      const xhrRequestHeaders = {
        Accept: acceptHeader,
      };

      if (headers) {
        Object.assign(xhrRequestHeaders, headers);
      }

      return xhrRequestHeaders;
    },
    errorInterceptor: error => {
      errorHandler.getHTTPErrorHandler(error);
    },
  };

  registerVolumeLoader('cornerstoneStreamingImageVolume', cornerstoneStreamingImageVolumeLoader);
  registerVolumeLoader(
    'cornerstoneStreamingDynamicImageVolume',
    cornerstoneStreamingDynamicImageVolumeLoader
  );

  // Cornerstone3D v2: use the init() function which accepts configuration
  // directly. The old configure() and external APIs were removed.
  dicomImageLoader.init(config);
}

export function destroy() {
  // Cornerstone3D v2: worker management is handled internally by
  // @cornerstonejs/core's getWebWorkerManager(). The old webWorkerManager
  // API was removed. No explicit worker termination needed.
}
