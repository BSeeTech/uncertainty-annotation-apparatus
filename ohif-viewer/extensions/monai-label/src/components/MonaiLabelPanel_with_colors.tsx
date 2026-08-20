/*
Copyright (c) MONAI Consortium
Licensed under the Apache License, Version 2.0 (the "License");
...

FEATURES:
- Improved color palette system with 5 options
- Anatomically intuitive colors for medical structures
- Colorblind-friendly palette
- Adjustable opacity slider
- Fixed segment rendering
*/

import React, { Component } from 'react';
import PropTypes from 'prop-types';
import './MonaiLabelPanel.css';
import AutoSegmentation from './actions/AutoSegmentation';
import PointPrompts from './actions/PointPrompts';
import ClassPrompts from './actions/ClassPrompts';
import ActiveLearning from './actions/ActiveLearning';
import MonaiLabelClient from '../services/MonaiLabelClient';
import { hideNotification } from '../utils/GenericUtils';
import { Enums } from '@cornerstonejs/tools';
import { cache, triggerEvent, eventTarget, getRenderingEngine } from '@cornerstonejs/core';
import SegmentationReader from '../utils/SegmentationReader';
import { currentSegmentsInfo } from '../utils/SegUtils';
import SettingsTable from './SettingsTable';
import * as cornerstoneTools from '@cornerstonejs/tools';

// ============================================================================
// COLOR PALETTE SYSTEM
// ============================================================================

type ColorPalette = 'anatomical' | 'highContrast' | 'colorblind' | 'pastel' | 'rainbow';

// Anatomically intuitive colors
const ANATOMICAL_COLORS: Record<string, [number, number, number]> = {
  // Organs
  'liver': [139, 69, 19],
  'spleen': [178, 34, 34],
  'kidney': [205, 92, 92],
  'kidney_left': [205, 92, 92],
  'kidney_right': [180, 82, 82],
  'pancreas': [255, 218, 185],
  'stomach': [255, 160, 122],
  'gallbladder': [107, 142, 35],
  
  // Heart & vessels
  'heart': [220, 20, 60],
  'aorta': [255, 0, 0],
  'inferior_vena_cava': [0, 0, 205],
  'portal_vein': [65, 105, 225],
  
  // Lungs
  'lung': [135, 206, 250],
  'lung_left': [135, 206, 250],
  'lung_right': [100, 149, 237],
  
  // GI tract
  'colon': [210, 180, 140],
  'small_bowel': [244, 164, 96],
  'duodenum': [222, 184, 135],
  'esophagus': [188, 143, 143],
  
  // Bones
  'bone': [255, 255, 224],
  'spine': [245, 245, 220],
  'rib': [253, 245, 230],
  
  // Tumors & lesions - High visibility
  'tumor': [255, 0, 255],
  'lesion': [255, 20, 147],
  'nodule': [255, 105, 180],
  
  // Bladder
  'bladder': [255, 255, 0],
  
  // Adrenal
  'adrenal': [218, 165, 32],
  'adrenal_left': [218, 165, 32],
  'adrenal_right': [184, 134, 11],
};

// High contrast neon colors
const HIGH_CONTRAST_COLORS: [number, number, number][] = [
  [0, 255, 0],       // Lime green
  [255, 0, 255],     // Magenta
  [0, 255, 255],     // Cyan
  [255, 255, 0],     // Yellow
  [255, 128, 0],     // Orange
  [128, 0, 255],     // Purple
  [255, 0, 128],     // Pink
  [0, 255, 128],     // Spring green
  [255, 64, 64],     // Coral red
  [64, 224, 208],    // Turquoise
  [255, 192, 203],   // Pink
  [144, 238, 144],   // Light green
];

// Colorblind-friendly (Okabe-Ito)
const COLORBLIND_FRIENDLY: [number, number, number][] = [
  [230, 159, 0],     // Orange
  [86, 180, 233],    // Sky blue
  [0, 158, 115],     // Bluish green
  [240, 228, 66],    // Yellow
  [0, 114, 178],     // Blue
  [213, 94, 0],      // Vermillion
  [204, 121, 167],   // Reddish purple
  [117, 117, 117],   // Gray
];

// Pastel colors
const PASTEL_COLORS: [number, number, number][] = [
  [255, 179, 186],   // Pastel pink
  [255, 223, 186],   // Pastel orange
  [255, 255, 186],   // Pastel yellow
  [186, 255, 201],   // Pastel green
  [186, 225, 255],   // Pastel blue
  [219, 186, 255],   // Pastel purple
  [255, 186, 255],   // Pastel magenta
  [186, 255, 255],   // Pastel cyan
];

// Rainbow gradient
const RAINBOW_COLORS: [number, number, number][] = [
  [255, 0, 0],       // Red
  [255, 127, 0],     // Orange
  [255, 255, 0],     // Yellow
  [127, 255, 0],     // Chartreuse
  [0, 255, 0],       // Green
  [0, 255, 127],     // Spring green
  [0, 255, 255],     // Cyan
  [0, 127, 255],     // Azure
  [0, 0, 255],       // Blue
  [127, 0, 255],     // Violet
  [255, 0, 255],     // Magenta
  [255, 0, 127],     // Rose
];

const OPACITY_PRESETS = {
  solid: 255,
  high: 204,
  medium: 153,
  low: 102,
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default class MonaiLabelPanel extends Component {
  static propTypes = {
    commandsManager: PropTypes.any,
    servicesManager: PropTypes.any,
    extensionManager: PropTypes.any,
  };

  notification: any;
  settings;
  actions: {
    activelearning: any;
    segmentation: any;
    pointprompts: any;
    classprompts: any;
  };
  serverURI = 'http://127.0.0.1:8000';

  constructor(props) {
    super(props);

    const { uiNotificationService } = props.servicesManager.services;
    this.notification = uiNotificationService;
    this.settings = React.createRef();
    this.actions = {
      activelearning: React.createRef(),
      segmentation: React.createRef(),
      pointprompts: React.createRef(),
      classprompts: React.createRef(),
    };

    this.state = {
      info: { models: [], datasets: [] },
      action: {},
      options: {},
      isDataReady: false,
      // NEW: Color settings
      colorPalette: 'highContrast' as ColorPalette,
      segmentOpacity: OPACITY_PRESETS.high,
    };
  }

  client = () => {
    const settings =
      this.settings && this.settings.current && this.settings.current.state
        ? this.settings.current.state
        : null;
    return new MonaiLabelClient(settings ? settings.url : this.serverURI);
  };

  // ============================================================================
  // COLOR METHODS
  // ============================================================================

  /**
   * Get color for a label using current palette
   */
  segmentColor = (label: string, index: number = 0): number[] => {
    const palette = this.state.colorPalette || 'highContrast';
    
    // Try anatomical color first
    const normalizedLabel = label.toLowerCase().replace(/[- ]/g, '_');
    if (ANATOMICAL_COLORS[normalizedLabel]) {
      return [...ANATOMICAL_COLORS[normalizedLabel]];
    }
    
    // Use palette-based color
    let colors: [number, number, number][];
    switch (palette) {
      case 'highContrast':
        colors = HIGH_CONTRAST_COLORS;
        break;
      case 'colorblind':
        colors = COLORBLIND_FRIENDLY;
        break;
      case 'pastel':
        colors = PASTEL_COLORS;
        break;
      case 'rainbow':
        colors = RAINBOW_COLORS;
        break;
      default:
        colors = HIGH_CONTRAST_COLORS;
    }
    
    return [...colors[index % colors.length]];
  };

  /**
   * Handle palette change - recolor all segments
   */
  handlePaletteChange = (palette: ColorPalette) => {
    this.setState({ colorPalette: palette }, () => {
      this.recolorAllSegments();
    });
  };

  /**
   * Handle opacity change
   */
  handleOpacityChange = (opacity: number) => {
    this.setState({ segmentOpacity: opacity }, () => {
      this.recolorAllSegments();
    });
  };

  /**
   * Recolor all existing segments with current palette/opacity
   */
  recolorAllSegments = () => {
    const labels = this.state.info.labels || [];
    const opacity = this.state.segmentOpacity;
    
    labels.forEach((label, index) => {
      const color = this.segmentColor(label, index);
      const segmentIndex = index + 1;
      
      try {
        // Update via cornerstoneTools API
        const { viewport } = this.getActiveViewportInfo();
        if (cornerstoneTools.segmentation?.config?.color?.setSegmentIndexColor) {
          cornerstoneTools.segmentation.config.color.setSegmentIndexColor(
            viewport.viewportId,
            '1',
            segmentIndex,
            [...color, opacity]
          );
        }
      } catch (e) {
        console.warn(`Could not update color for ${label}:`, e.message);
      }
    });
    
    this.forceViewportRender();
  };

  // ============================================================================
  // VIEWPORT METHODS
  // ============================================================================

  getActiveViewportInfo = () => {
    const { viewportGridService, displaySetService } =
      this.props.servicesManager.services;
    const { viewports, activeViewportId } = viewportGridService.getState();
    const viewport = viewports.get(activeViewportId);
    const displaySet = displaySetService.getDisplaySetByUID(
      viewport.displaySetInstanceUIDs[0]
    );
    return { viewport, displaySet };
  };

  setSegmentColorDirectly = (segmentIndex: number, color: number[]) => {
    try {
      const { viewport } = this.getActiveViewportInfo();
      const rgba = [...color.slice(0, 3), this.state.segmentOpacity];
      
      if (cornerstoneTools.segmentation?.config?.color?.setSegmentIndexColor) {
        cornerstoneTools.segmentation.config.color.setSegmentIndexColor(
          viewport.viewportId,
          '1',
          segmentIndex,
          rgba
        );
      }
    } catch (e) {
      console.warn('Could not set segment color:', e.message);
    }
  };

  forceViewportRender = () => {
    try {
      const renderingEngine = getRenderingEngine('ohifRenderingEngine');
      if (renderingEngine) {
        renderingEngine.render();
        return;
      }
      window.dispatchEvent(new Event('resize'));
    } catch (e) {
      console.warn('Could not force render:', e.message);
    }
  };

  refreshSegmentVisibility = (labels: string[], labelNames: Record<string, number>) => {
    try {
      const { segmentationService } = this.props.servicesManager.services;
      
      for (const label of labels) {
        const segmentIndex = labelNames[label];
        if (segmentIndex === undefined) continue;
        
        if (segmentationService.setSegmentVisibility) {
          segmentationService.setSegmentVisibility('1', segmentIndex, false);
          setTimeout(() => {
            segmentationService.setSegmentVisibility('1', segmentIndex, true);
          }, 50);
        }
      }
    } catch (e) {
      console.warn('Could not refresh visibility:', e.message);
    }
  };

  // ============================================================================
  // onInfo - Server Connection
  // ============================================================================

  onInfo = async (serverURI) => {
    const nid = this.notification.show({
      title: 'MONAI Label',
      message: 'Connecting to MONAI Label',
      type: 'info',
      duration: 2000,
    });

    this.serverURI = serverURI;
    const response = await this.client().info();
    console.log(response.data);

    hideNotification(nid, this.notification);
    if (response.status !== 200) {
      this.notification.show({
        title: 'MONAI Label',
        message: 'Failed to Connect to MONAI Label',
        type: 'error',
        duration: 5000,
      });
      return;
    }

    this.notification.show({
      title: 'MONAI Label',
      message: 'Connected to MONAI Label - Successful',
      type: 'success',
      duration: 2000,
    });

    // Parse models and labels
    const all_models = response.data.models;
    const all_model_names = Object.keys(all_models);
    const models = all_model_names.filter(
      (m) => ['deepgrow', 'deepedit', 'vista3d', 'segmentation'].includes(all_models[m].type)
    );
    
    const all_labels = [...response.data.labels];
    const modelLabelToIdxMap = {};
    const modelIdxToLabelMap = {};
    const modelLabelNames = {};
    const modelLabelIndices = {};

    for (const model of models) {
      const labels = all_models[model]['labels'];
      modelLabelToIdxMap[model] = {};
      modelIdxToLabelMap[model] = {};
      
      if (Array.isArray(labels)) {
        for (let label_idx = 1; label_idx <= labels.length; label_idx++) {
          const label = labels[label_idx - 1];
          all_labels.push(label);
          modelLabelToIdxMap[model][label] = label_idx;
          modelIdxToLabelMap[model][label_idx] = label;
        }
      } else {
        for (const label of Object.keys(labels)) {
          const label_idx = labels[label];
          all_labels.push(label);
          modelLabelToIdxMap[model][label] = label_idx;
          modelIdxToLabelMap[model][label_idx] = label;
        }
      }
      
      modelLabelNames[model] = [...Object.keys(modelLabelToIdxMap[model])].sort();
      modelLabelIndices[model] = [...Object.keys(modelIdxToLabelMap[model])].sort().map(Number);
    }

    const labelsOrdered = [...new Set(all_labels)].sort();

    // Create segments with improved colors
    const segmentsArray = [null];
    const segmentsMap = {};

    labelsOrdered.forEach((label, index) => {
      const segmentIndex = index + 1;
      const color = this.segmentColor(label, index);
      
      const segment = {
        segmentIndex: segmentIndex,
        label: label,
        active: index === 0,
        locked: false,
        isLocked: false,
        isVisible: true,
        color: color,
      };

      segmentsArray.push(segment);
      segmentsMap[segmentIndex] = segment;
    });

    const segmentations = [
      {
        id: '1',
        segmentationId: '1',
        label: 'Segmentations',
        segments: segmentsArray,
        representation: { type: Enums.SegmentationRepresentations.Labelmap },
        config: { label: 'Segmentations', segments: segmentsMap },
      },
    ];

    const volumeLoadObject = cache.getVolume('1');
    if (!volumeLoadObject) {
      this.props.commandsManager.runCommand('loadSegmentationsForViewport', { segmentations });

      // Set colors after loading
      setTimeout(() => {
        try {
          const { viewport } = this.getActiveViewportInfo();
          for (let i = 1; i < segmentsArray.length; i++) {
            const segment = segmentsArray[i];
            if (cornerstoneTools.segmentation?.config?.color?.setSegmentIndexColor) {
              cornerstoneTools.segmentation.config.color.setSegmentIndexColor(
                viewport.viewportId,
                '1',
                segment.segmentIndex,
                [...segment.color, this.state.segmentOpacity]
              );
            }
          }
        } catch (e) {
          console.warn('Could not set segment colors:', e.message);
        }
      }, 1000);
    }

    const info = {
      models,
      labels: labelsOrdered,
      data: response.data,
      modelLabelToIdxMap,
      modelIdxToLabelMap,
      modelLabelNames,
      modelLabelIndices,
      initialSegs: segmentsArray,
    };

    console.log(info);
    this.setState({ info, isDataReady: true, options: {} });
  };

  // ============================================================================
  // updateView - Apply Segmentation Results
  // ============================================================================

  updateView = async (
    response,
    model_id,
    labels,
    override = false,
    label_class_unknown = false,
    sidx = -1
  ) => {
    console.log('UpdateView:', { model_id, labels });
    
    const ret = SegmentationReader.parseNrrdData(response.data);
    if (!ret) throw new Error('Failed to parse NRRD data');

    const { segmentationService } = this.props.servicesManager.services;
    const currentSegs = currentSegmentsInfo(segmentationService);
    const labelNames = {};
    const modelToSegMapping = { 0: 0 };

    let tmp_model_seg_idx = 1;
    
    // Build mapping and ensure segments exist
    for (const label of labels) {
      const existingSegment = currentSegs.info[label];
      
      if (!existingSegment) {
        let freeIndex = -1;
        for (let i = 1; i <= 255; i++) {
          if (!currentSegs.indices.has(i)) {
            freeIndex = i;
            currentSegs.indices.add(i);
            break;
          }
        }
        
        if (freeIndex === -1) {
          console.error('No free index for:', label);
          continue;
        }
        
        labelNames[label] = freeIndex;
        
        // Add segment with color
        const color = this.segmentColor(label, labels.indexOf(label));
        try {
          if (segmentationService.addSegment) {
            await segmentationService.addSegment('1', {
              segmentIndex: freeIndex,
              label: label,
              color: [...color, this.state.segmentOpacity],
              isLocked: false,
              isVisible: true,
              active: false,
            });
            console.log(`Added segment: ${label} at index ${freeIndex}`);
          } else {
            this.setSegmentColorDirectly(freeIndex, color);
          }
        } catch (e) {
          this.setSegmentColorDirectly(freeIndex, color);
        }
      } else {
        labelNames[label] = existingSegment.segmentIndex;
      }

      const seg_idx = labelNames[label];
      let model_seg_idx = this.state.info.modelLabelToIdxMap[model_id]?.[label] ?? tmp_model_seg_idx;
      modelToSegMapping[model_seg_idx] = 0xff & seg_idx;
      tmp_model_seg_idx++;
    }

    console.log('Index Remap:', labels, modelToSegMapping);

    // Get volume and write data
    const volumeLoadObject = segmentationService.getLabelmapVolume('1');
    if (!volumeLoadObject) {
      console.error('No labelmap volume');
      return;
    }

    const data = new Uint8Array(ret.image);
    let nonZeroCount = 0;

    for (let i = 0; i < data.length; i++) {
      const modelIdx = data[i];
      if (modelIdx === 0) {
        if (!override) continue;
        data[i] = 0;
      } else {
        const segIdx = modelToSegMapping[modelIdx];
        if (segIdx !== undefined && segIdx !== 0) {
          data[i] = segIdx;
          nonZeroCount++;
        } else if (override && label_class_unknown && labels.length === 1) {
          data[i] = modelIdx ? labelNames[labels[0]] : 0;
        } else {
          data[i] = 0;
        }
      }
    }

    console.log(`Non-zero voxels: ${nonZeroCount}`);

    // Write to volume
    const { voxelManager } = volumeLoadObject;
    if (voxelManager?.setCompleteScalarDataArray) {
      voxelManager.setCompleteScalarDataArray(data);
    } else if (volumeLoadObject.getScalarData) {
      const scalarData = volumeLoadObject.getScalarData();
      if (override) {
        scalarData.set(data);
      } else {
        for (let i = 0; i < data.length; i++) {
          if (data[i] !== 0) scalarData[i] = data[i];
        }
      }
    }

    // Force update
    volumeLoadObject.modified?.();
    volumeLoadObject.imageData?.modified?.();
    
    triggerEvent(eventTarget, Enums.Events.SEGMENTATION_DATA_MODIFIED, { segmentationId: '1' });
    
    setTimeout(() => this.forceViewportRender(), 100);
    setTimeout(() => this.refreshSegmentVisibility(labels, labelNames), 200);
    
    console.log('UpdateView complete');
  };

  onSelectActionTab = (name) => {
    for (const action of Object.keys(this.actions)) {
      if (this.state.action === action && this.actions[action].current) {
        this.actions[action].current.onLeaveActionTab();
      }
    }
    for (const action of Object.keys(this.actions)) {
      if (name === action && this.actions[action].current) {
        this.actions[action].current.onEnterActionTab();
      }
    }
    this.setState({ action: name });
  };

  async componentDidMount() {
    if (this.state.isDataReady) return;
    console.log('(Component Mounted) Ready to Connect to MONAI Server...');
  }

  onOptionsConfig = () => this.state.options;

  // ============================================================================
  // RENDER
  // ============================================================================

  render() {
    const { isDataReady, colorPalette, segmentOpacity } = this.state;
    
    return (
      <div className="monaiLabelPanel">
        <br style={{ margin: '3px' }} />

        <SettingsTable ref={this.settings} onInfo={this.onInfo} />
        
        {isDataReady && (
          <div style={{ color: 'white' }}>
            <p className="subtitle">{this.state.info.data.name}</p>
            <br />
            
            {/* COLOR PALETTE SELECTOR */}
            <div style={{ 
              padding: '12px', 
              background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)', 
              borderRadius: '8px',
              marginBottom: '15px',
              border: '1px solid #333'
            }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '10px', 
                fontWeight: 'bold',
                fontSize: '14px',
                color: '#e0e0e0'
              }}>
                🎨 Display Settings
              </label>
              
              <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: '#aaa' }}>
                Color Palette:
              </label>
              <select
                value={colorPalette}
                onChange={(e) => this.handlePaletteChange(e.target.value as ColorPalette)}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '6px',
                  backgroundColor: '#2d2d44',
                  color: 'white',
                  border: '1px solid #444',
                  marginBottom: '12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                <option value="highContrast">🔆 High Contrast (Neon)</option>
                <option value="anatomical">🫀 Anatomical</option>
                <option value="colorblind">👁️ Colorblind Friendly</option>
                <option value="pastel">🌸 Pastel (Soft)</option>
                <option value="rainbow">🌈 Rainbow</option>
              </select>
              
              <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: '#aaa' }}>
                Opacity: {Math.round((segmentOpacity / 255) * 100)}%
              </label>
              <input
                type="range"
                min="25"
                max="255"
                value={segmentOpacity}
                onChange={(e) => this.handleOpacityChange(parseInt(e.target.value))}
                style={{ 
                  width: '100%',
                  cursor: 'pointer',
                  accentColor: '#0ea5e9',
                }}
              />
              
              {/* Quick opacity presets */}
              <div style={{ display: 'flex', gap: '5px', marginTop: '8px' }}>
                {[
                  { label: '40%', value: 102 },
                  { label: '60%', value: 153 },
                  { label: '80%', value: 204 },
                  { label: '100%', value: 255 },
                ].map((preset) => (
                  <button
                    key={preset.value}
                    onClick={() => this.handleOpacityChange(preset.value)}
                    style={{
                      flex: 1,
                      padding: '4px 8px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: segmentOpacity === preset.value ? '2px solid #0ea5e9' : '1px solid #444',
                      backgroundColor: segmentOpacity === preset.value ? '#0ea5e9' : '#2d2d44',
                      color: 'white',
                      cursor: 'pointer',
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            
            <hr className="separator" />
          </div>
        )}
        
        {isDataReady && (
          <div className="tabs scrollbar" id="style-3">
            <AutoSegmentation
              ref={this.actions['segmentation']}
              tabIndex={2}
              info={this.state.info}
              client={this.client}
              updateView={this.updateView}
              onSelectActionTab={this.onSelectActionTab}
              onOptionsConfig={this.onOptionsConfig}
              getActiveViewportInfo={this.getActiveViewportInfo}
            />
            <PointPrompts
              ref={this.actions['pointprompts']}
              tabIndex={3}
              info={this.state.info}
              client={this.client}
              updateView={this.updateView}
              onSelectActionTab={this.onSelectActionTab}
              onOptionsConfig={this.onOptionsConfig}
              getActiveViewportInfo={this.getActiveViewportInfo}
              servicesManager={this.props.servicesManager}
              commandsManager={this.props.commandsManager}
            />
            <ClassPrompts
              ref={this.actions['classprompts']}
              tabIndex={4}
              info={this.state.info}
              client={this.client}
              updateView={this.updateView}
              onSelectActionTab={this.onSelectActionTab}
              onOptionsConfig={this.onOptionsConfig}
              getActiveViewportInfo={this.getActiveViewportInfo}
              servicesManager={this.props.servicesManager}
              commandsManager={this.props.commandsManager}
            />
          </div>
        )}
      </div>
    );
  }
}
