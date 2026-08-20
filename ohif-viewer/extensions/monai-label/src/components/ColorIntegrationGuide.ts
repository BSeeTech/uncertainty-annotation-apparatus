/**
 * Integration Guide: Improved Color System for MonaiLabelPanel
 * 
 * This file shows how to integrate the new SegmentationColors module
 * into your MonaiLabelPanel.tsx
 */

// ============================================================================
// STEP 1: Import the color module (add to top of MonaiLabelPanel.tsx)
// ============================================================================

import { 
  getLabelColor, 
  getHashedColor,
  ANATOMICAL_COLORS,
  HIGH_CONTRAST_COLORS,
  COLORBLIND_FRIENDLY,
  OPACITY_PRESETS,
  ColorPalette,
  adjustBrightness
} from '../utils/SegmentationColors';

// ============================================================================
// STEP 2: Add state for color palette selection
// ============================================================================

// In constructor, add to this.state:
/*
this.state = {
  info: { models: [], datasets: [] },
  action: {},
  options: {},
  colorPalette: 'highContrast' as ColorPalette,  // ADD THIS
  segmentOpacity: OPACITY_PRESETS.high,           // ADD THIS
};
*/

// ============================================================================
// STEP 3: Replace the segmentColor method
// ============================================================================

/**
 * NEW segmentColor method with palette support
 * Replace the existing method in MonaiLabelPanel class
 */
segmentColor = (label: string, index: number = 0): number[] => {
  const palette = this.state.colorPalette || 'highContrast';
  
  // Try anatomical color first (works with any palette)
  const normalizedLabel = label.toLowerCase().replace(/[- ]/g, '_');
  
  if (ANATOMICAL_COLORS[normalizedLabel]) {
    return [...ANATOMICAL_COLORS[normalizedLabel]];
  }
  
  // Use palette-based color
  const color = getLabelColor(label, index, palette);
  return [...color];
};

/**
 * Alternative: Hash-based color (same label = same color always)
 */
segmentColorHashed = (label: string): number[] => {
  // Check anatomical first
  const normalizedLabel = label.toLowerCase().replace(/[- ]/g, '_');
  if (ANATOMICAL_COLORS[normalizedLabel]) {
    return [...ANATOMICAL_COLORS[normalizedLabel]];
  }
  
  // Generate consistent color from label name
  return [...getHashedColor(label)];
};

// ============================================================================
// STEP 4: Add UI controls for color palette (add to render method)
// ============================================================================

/**
 * Add this JSX inside the settings/options area of your panel
 */
const ColorPaletteSelector = () => (
  <div className="color-palette-selector" style={{ marginBottom: '10px' }}>
    <label style={{ color: 'white', display: 'block', marginBottom: '5px' }}>
      Color Palette:
    </label>
    <select
      value={this.state.colorPalette}
      onChange={(e) => this.handlePaletteChange(e.target.value as ColorPalette)}
      style={{
        width: '100%',
        padding: '5px',
        borderRadius: '4px',
        backgroundColor: '#2d2d2d',
        color: 'white',
        border: '1px solid #444',
      }}
    >
      <option value="highContrast">High Contrast (Neon)</option>
      <option value="anatomical">Anatomical</option>
      <option value="colorblind">Colorblind Friendly</option>
      <option value="pastel">Pastel (Soft)</option>
      <option value="rainbow">Rainbow</option>
    </select>
    
    <label style={{ color: 'white', display: 'block', marginTop: '10px', marginBottom: '5px' }}>
      Opacity:
    </label>
    <input
      type="range"
      min="25"
      max="255"
      value={this.state.segmentOpacity}
      onChange={(e) => this.handleOpacityChange(parseInt(e.target.value))}
      style={{ width: '100%' }}
    />
    <span style={{ color: '#aaa', fontSize: '12px' }}>
      {Math.round((this.state.segmentOpacity / 255) * 100)}%
    </span>
  </div>
);

// ============================================================================
// STEP 5: Add handler methods
// ============================================================================

/**
 * Handle palette change - recolor all existing segments
 */
handlePaletteChange = async (palette: ColorPalette) => {
  this.setState({ colorPalette: palette });
  
  // Recolor existing segments
  const { segmentationService } = this.props.servicesManager.services;
  const labels = this.state.info.labels || [];
  
  labels.forEach((label, index) => {
    const color = this.segmentColor(label, index);
    const segmentIndex = index + 1;
    
    try {
      // Update color in segmentation service
      if (segmentationService.setSegmentColor) {
        segmentationService.setSegmentColor('1', segmentIndex, [...color, this.state.segmentOpacity]);
      }
      
      // Also update via cornerstoneTools API
      this.setSegmentColorDirectly(segmentIndex, color);
    } catch (e) {
      console.warn(`Could not update color for ${label}:`, e.message);
    }
  });
  
  // Force render
  this.forceViewportRender();
};

/**
 * Handle opacity change for all segments
 */
handleOpacityChange = (opacity: number) => {
  this.setState({ segmentOpacity: opacity });
  
  const { segmentationService } = this.props.servicesManager.services;
  const labels = this.state.info.labels || [];
  
  labels.forEach((label, index) => {
    const color = this.segmentColor(label, index);
    const segmentIndex = index + 1;
    
    try {
      if (segmentationService.setSegmentColor) {
        segmentationService.setSegmentColor('1', segmentIndex, [...color, opacity]);
      }
    } catch (e) {
      // Ignore errors
    }
  });
  
  this.forceViewportRender();
};

// ============================================================================
// STEP 6: Update onInfo to use new color system
// ============================================================================

/**
 * In the onInfo method, update the segment creation loop:
 */
// Replace this section in onInfo:
/*
labelsOrdered.forEach((label, index) => {
  const segmentIndex = index + 1;
  const color = this.segmentColor(label, index);  // Pass index for palette cycling
  
  const segment = {
    segmentIndex: segmentIndex,
    label: label,
    active: index === 0,
    locked: false,
    isLocked: false,
    isVisible: true,
    color: color,
    opacity: this.state.segmentOpacity || OPACITY_PRESETS.high,
  };

  segmentsArray.push(segment);
  segmentsMap[segmentIndex] = segment;
});
*/

// ============================================================================
// STEP 7: CSS for the color selector (add to MonaiLabelPanel.css)
// ============================================================================

/*
.color-palette-selector {
  padding: 10px;
  background: #1a1a1a;
  border-radius: 4px;
  margin-bottom: 15px;
}

.color-palette-selector select {
  cursor: pointer;
}

.color-palette-selector select:hover {
  border-color: #666;
}

.color-palette-selector input[type="range"] {
  -webkit-appearance: none;
  height: 6px;
  background: #444;
  border-radius: 3px;
  cursor: pointer;
}

.color-palette-selector input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  background: #0ea5e9;
  border-radius: 50%;
  cursor: pointer;
}
*/

// ============================================================================
// COMPLETE EXAMPLE: Full render method with color selector
// ============================================================================

/*
render() {
  const { isDataReady } = this.state;
  return (
    <div className="monaiLabelPanel">
      <br style={{ margin: '3px' }} />

      <SettingsTable ref={this.settings} onInfo={this.onInfo} />
      
      {isDataReady && (
        <div style={{ color: 'white' }}>
          <p className="subtitle">{this.state.info.data.name}</p>
          <br />
          
          {/* COLOR PALETTE SELECTOR */}
          <div className="color-palette-selector" style={{ marginBottom: '10px', padding: '10px', background: '#1a1a1a', borderRadius: '4px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
              🎨 Display Settings
            </label>
            
            <label style={{ display: 'block', marginBottom: '3px', fontSize: '12px' }}>
              Color Palette:
            </label>
            <select
              value={this.state.colorPalette}
              onChange={(e) => this.handlePaletteChange(e.target.value)}
              style={{
                width: '100%',
                padding: '5px',
                borderRadius: '4px',
                backgroundColor: '#2d2d2d',
                color: 'white',
                border: '1px solid #444',
                marginBottom: '10px',
              }}
            >
              <option value="highContrast">🔆 High Contrast</option>
              <option value="anatomical">🫀 Anatomical</option>
              <option value="colorblind">👁️ Colorblind Friendly</option>
              <option value="pastel">🌸 Pastel</option>
              <option value="rainbow">🌈 Rainbow</option>
            </select>
            
            <label style={{ display: 'block', marginBottom: '3px', fontSize: '12px' }}>
              Opacity: {Math.round((this.state.segmentOpacity / 255) * 100)}%
            </label>
            <input
              type="range"
              min="25"
              max="255"
              value={this.state.segmentOpacity}
              onChange={(e) => this.handleOpacityChange(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
          
          <hr className="separator" />
          <a href="#" onClick={this.openConfigurations}>
            Options / Configurations
          </a>
          <hr className="separator" />
        </div>
      )}
      
      {isDataReady && (
        <div className="tabs scrollbar" id="style-3">
          {/* ... rest of tabs ... */}
        </div>
      )}
    </div>
  );
}
*/

export default {
  segmentColor,
  segmentColorHashed,
  handlePaletteChange,
  handleOpacityChange,
};
