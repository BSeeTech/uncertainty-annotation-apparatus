import { u as setLoggerFunction } from '@kitware/vtk.js/macros2.js';
import {
  PanTool,
  WindowLevelTool,
  StackScrollTool,
  ZoomTool,
  VolumeRotateTool,
  MIPJumpToClickTool,
  LengthTool,
  RectangleROITool,
  RectangleROIThresholdTool,
  EllipticalROITool,
  CircleROITool,
  BidirectionalTool,
  ArrowAnnotateTool,
  DragProbeTool,
  ProbeTool,
  AngleTool,
  CobbAngleTool,
  MagnifyTool,
  CrosshairsTool,
  RectangleScissorsTool,
  SphereScissorsTool,
  CircleScissorsTool,
  BrushTool,
  PaintFillTool,
  init,
  addTool,
  annotation,
  ReferenceLinesTool,
  TrackballRotateTool,
  AdvancedMagnifyTool,
  UltrasoundDirectionalTool,
  PlanarFreehandROITool,
  SplineROITool,
  LivewireContourTool,
  OrientationMarkerTool,
  WindowLevelRegionTool,
} from '@cornerstonejs/tools';

import CalibrationLineTool from './tools/CalibrationLineTool';
import ImageOverlayViewerTool from './tools/ImageOverlayViewerTool';

/**
 * Suppress vtk.js 'Set value to model directly' warnings.
 * These are cosmetic warnings triggered by Cornerstone3D V2's internal
 * viewport setup where vtk model properties are assigned directly
 * rather than through the macro setter.  No functional impact.
 *
 * We use vtk.js's own setLoggerFunction API because vtk.js captures
 * console.warn at module load time, making a simple console.warn override
 * ineffective.
 */
function suppressVtkDirectModelWarning() {
  setLoggerFunction('warn', () => {});
}

export default function initCornerstoneTools(configuration = {}) {
  suppressVtkDirectModelWarning();
  CrosshairsTool.isAnnotation = false;
  ReferenceLinesTool.isAnnotation = false;
  AdvancedMagnifyTool.isAnnotation = false;

  init(configuration);
  addTool(PanTool);
  addTool(WindowLevelTool);
  addTool(StackScrollTool);
  addTool(ZoomTool);
  addTool(ProbeTool);
  addTool(VolumeRotateTool);
  addTool(MIPJumpToClickTool);
  addTool(LengthTool);
  addTool(RectangleROITool);
  addTool(RectangleROIThresholdTool);
  addTool(EllipticalROITool);
  addTool(CircleROITool);
  addTool(BidirectionalTool);
  addTool(ArrowAnnotateTool);
  addTool(DragProbeTool);
  addTool(AngleTool);
  addTool(CobbAngleTool);
  addTool(MagnifyTool);
  addTool(CrosshairsTool);
  addTool(RectangleScissorsTool);
  addTool(SphereScissorsTool);
  addTool(CircleScissorsTool);
  addTool(BrushTool);
  addTool(PaintFillTool);
  addTool(ReferenceLinesTool);
  addTool(CalibrationLineTool);
  addTool(TrackballRotateTool);
  addTool(ImageOverlayViewerTool);
  addTool(AdvancedMagnifyTool);
  addTool(UltrasoundDirectionalTool);
  addTool(PlanarFreehandROITool);
  addTool(SplineROITool);
  addTool(LivewireContourTool);
  addTool(OrientationMarkerTool);
  addTool(WindowLevelRegionTool);

  // Modify annotation tools to use dashed lines on SR
  const annotationStyle = {
    textBoxFontSize: '15px',
    lineWidth: '1.5',
  };

  const defaultStyles = annotation.config.style.getDefaultToolStyles();
  annotation.config.style.setDefaultToolStyles({
    global: {
      ...defaultStyles.global,
      ...annotationStyle,
    },
  });
}

const toolNames = {
  Pan: PanTool.toolName,
  ArrowAnnotate: ArrowAnnotateTool.toolName,
  WindowLevel: WindowLevelTool.toolName,
  StackScroll: StackScrollTool.toolName,
  Zoom: ZoomTool.toolName,
  VolumeRotateMouseWheel: VolumeRotateTool.toolName,
  MipJumpToClick: MIPJumpToClickTool.toolName,
  Length: LengthTool.toolName,
  DragProbe: DragProbeTool.toolName,
  Probe: ProbeTool.toolName,
  RectangleROI: RectangleROITool.toolName,
  RectangleROIThreshold: RectangleROIThresholdTool.toolName,
  EllipticalROI: EllipticalROITool.toolName,
  CircleROI: CircleROITool.toolName,
  Bidirectional: BidirectionalTool.toolName,
  Angle: AngleTool.toolName,
  CobbAngle: CobbAngleTool.toolName,
  Magnify: MagnifyTool.toolName,
  Crosshairs: CrosshairsTool.toolName,
  Brush: BrushTool.toolName,
  PaintFill: PaintFillTool.toolName,
  ReferenceLines: ReferenceLinesTool.toolName,
  CalibrationLine: CalibrationLineTool.toolName,
  TrackballRotateTool: TrackballRotateTool.toolName,
  CircleScissors: CircleScissorsTool.toolName,
  RectangleScissors: RectangleScissorsTool.toolName,
  SphereScissors: SphereScissorsTool.toolName,
  ImageOverlayViewer: ImageOverlayViewerTool.toolName,
  AdvancedMagnify: AdvancedMagnifyTool.toolName,
  UltrasoundDirectional: UltrasoundDirectionalTool.toolName,
  SplineROI: SplineROITool.toolName,
  LivewireContour: LivewireContourTool.toolName,
  PlanarFreehandROI: PlanarFreehandROITool.toolName,
  OrientationMarker: OrientationMarkerTool.toolName,
  WindowLevelRegion: WindowLevelRegionTool.toolName,
};

export { toolNames };
