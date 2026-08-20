const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const initSource = read('extensions/cornerstone/src/init.tsx');
const wadoSource = read('extensions/cornerstone/src/initWADOImageLoader.js');
const indexSource = read('extensions/cornerstone/src/index.tsx');
const viewportServiceSource = read(
  'extensions/cornerstone/src/services/ViewportService/CornerstoneViewportService.ts'
);

assert(
  initSource.includes('@cornerstonejs/core/loaders'),
  'Cornerstone init must import streaming volume loaders from @cornerstonejs/core/loaders'
);
assert(
  wadoSource.includes('@cornerstonejs/core/loaders'),
  'WADO init must import streaming volume loaders from @cornerstonejs/core/loaders'
);
assert(
  !initSource.includes('@cornerstonejs/streaming-image-volume-loader'),
  'Cornerstone init must not import the v1 streaming-image-volume-loader package'
);
assert(
  !wadoSource.includes('@cornerstonejs/streaming-image-volume-loader'),
  'WADO init must not import the v1 streaming-image-volume-loader package'
);
assert(
  !indexSource.includes('@cornerstonejs/streaming-image-volume-loader'),
  'Cornerstone extension index must not import the v1 streaming-image-volume-loader package'
);

for (const packagePath of [
  'extensions/cornerstone/package.json',
  'extensions/cornerstone-dynamic-volume/package.json',
]) {
  const manifest = readJson(packagePath);
  assert(
    !manifest.dependencies?.['@cornerstonejs/streaming-image-volume-loader'],
    `${packagePath} must not depend on the v1 streaming-image-volume-loader package`
  );
}

const coreLoader = read('node_modules/@cornerstonejs/core/dist/esm/loaders/cornerstoneStreamingImageVolumeLoader.js');
assert(coreLoader.includes('dataType'), 'Core v2 ESM volume loader must pass dataType');
assert(
  coreLoader.includes('numberOfComponents'),
  'Core v2 ESM volume loader must pass numberOfComponents'
);

for (const loaderPath of [
  'node_modules/@cornerstonejs/streaming-image-volume-loader/dist/esm/cornerstoneStreamingImageVolumeLoader.js',
  'node_modules/@cornerstonejs/streaming-image-volume-loader/dist/cjs/cornerstoneStreamingImageVolumeLoader.js',
]) {
  const source = read(loaderPath);
  assert(source.includes('dataType'), `${loaderPath} must pass dataType for cache-stale fallback safety`);
}

assert(
  !viewportServiceSource.includes('csToolsUtils.jumpToSlice'),
  'CornerstoneViewportService must use Cornerstone3D v2 core utilities.jumpToSlice, not tools.utilities.jumpToSlice'
);
assert(
  viewportServiceSource.includes('csUtils.jumpToSlice'),
  'CornerstoneViewportService must call csUtils.jumpToSlice for v2 slice navigation'
);
assert(
  viewportServiceSource.includes('if (!properties)'),
  'CornerstoneViewportService must tolerate undefined v2 getProperties(volumeId) results'
);

console.log('Cornerstone3D v2 streaming volume loader verification passed.');
