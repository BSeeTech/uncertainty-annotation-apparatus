/**
 * Segmentation Color Palette System
 * 
 * Optimized for medical imaging with:
 * - High contrast against grayscale CT/MRI backgrounds
 * - Distinguishable colors for adjacent organs
 * - Colorblind-friendly options
 * - Anatomically intuitive assignments
 */

// ============================================================================
// COLOR PALETTE OPTIONS
// ============================================================================

/**
 * OPTION 1: Anatomically Intuitive Colors
 * Colors that match common medical conventions
 */
export const ANATOMICAL_COLORS: Record<string, [number, number, number]> = {
  // Organs - Warm tones for solid organs
  'liver': [139, 69, 19],        // Saddle brown
  'spleen': [178, 34, 34],       // Firebrick red
  'kidney': [205, 92, 92],       // Indian red
  'kidney_left': [205, 92, 92],
  'kidney_right': [180, 82, 82],
  'pancreas': [255, 218, 185],   // Peach
  'stomach': [255, 160, 122],    // Light salmon
  'gallbladder': [107, 142, 35], // Olive drab
  
  // Heart & vessels - Red/blue convention
  'heart': [220, 20, 60],        // Crimson
  'aorta': [255, 0, 0],          // Pure red
  'inferior_vena_cava': [0, 0, 205], // Medium blue
  'portal_vein': [65, 105, 225], // Royal blue
  
  // Lungs - Light airy colors
  'lung': [135, 206, 250],       // Light sky blue
  'lung_left': [135, 206, 250],
  'lung_right': [100, 149, 237], // Cornflower blue
  
  // GI tract - Earthy tones
  'colon': [210, 180, 140],      // Tan
  'small_bowel': [244, 164, 96], // Sandy brown
  'duodenum': [222, 184, 135],   // Burlywood
  'esophagus': [188, 143, 143],  // Rosy brown
  
  // Bones - White/gray
  'bone': [255, 255, 224],       // Light yellow
  'spine': [245, 245, 220],      // Beige
  'rib': [253, 245, 230],        // Old lace
  
  // Muscles & soft tissue
  'muscle': [205, 133, 63],      // Peru
  'skin': [255, 228, 196],       // Bisque
  'fat': [255, 250, 205],        // Lemon chiffon
  
  // Tumors & lesions - High visibility
  'tumor': [255, 0, 255],        // Magenta
  'lesion': [255, 20, 147],      // Deep pink
  'nodule': [255, 105, 180],     // Hot pink
  'metastasis': [199, 21, 133],  // Medium violet red
  
  // Brain structures
  'brain': [255, 182, 193],      // Light pink
  'ventricle': [0, 206, 209],    // Dark turquoise
  'white_matter': [255, 248, 220], // Cornsilk
  'gray_matter': [192, 192, 192], // Silver
  
  // Bladder & urinary
  'bladder': [255, 255, 0],      // Yellow
  'ureter': [255, 215, 0],       // Gold
  
  // Adrenal
  'adrenal': [218, 165, 32],     // Goldenrod
  'adrenal_left': [218, 165, 32],
  'adrenal_right': [184, 134, 11], // Dark goldenrod
  
  // Default/unknown
  'background': [0, 0, 0],
  'unknown': [128, 128, 128],
};

/**
 * OPTION 2: High Contrast Neon Colors
 * Maximum visibility against dark backgrounds
 */
export const HIGH_CONTRAST_COLORS: [number, number, number][] = [
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
  [255, 165, 0],     // Orange
  [138, 43, 226],    // Blue violet
  [0, 191, 255],     // Deep sky blue
  [255, 99, 71],     // Tomato
];

/**
 * OPTION 3: Colorblind-Friendly Palette (Okabe-Ito)
 * Distinguishable for deuteranopia, protanopia, tritanopia
 */
export const COLORBLIND_FRIENDLY: [number, number, number][] = [
  [230, 159, 0],     // Orange
  [86, 180, 233],    // Sky blue
  [0, 158, 115],     // Bluish green
  [240, 228, 66],    // Yellow
  [0, 114, 178],     // Blue
  [213, 94, 0],      // Vermillion
  [204, 121, 167],   // Reddish purple
  [117, 117, 117],   // Gray (for less important)
];

/**
 * OPTION 4: Pastel Colors
 * Softer appearance, less eye strain for long viewing
 */
export const PASTEL_COLORS: [number, number, number][] = [
  [255, 179, 186],   // Pastel pink
  [255, 223, 186],   // Pastel orange
  [255, 255, 186],   // Pastel yellow
  [186, 255, 201],   // Pastel green
  [186, 225, 255],   // Pastel blue
  [219, 186, 255],   // Pastel purple
  [255, 186, 255],   // Pastel magenta
  [186, 255, 255],   // Pastel cyan
  [255, 209, 220],   // Light pink
  [209, 255, 220],   // Light mint
  [220, 209, 255],   // Light lavender
  [255, 245, 186],   // Light cream
];

/**
 * OPTION 5: Rainbow Gradient
 * Good for sequential/ordinal data
 */
export const RAINBOW_COLORS: [number, number, number][] = [
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

// ============================================================================
// COLOR UTILITY FUNCTIONS
// ============================================================================

export type ColorPalette = 'anatomical' | 'highContrast' | 'colorblind' | 'pastel' | 'rainbow';

/**
 * Get color for a label using the specified palette
 */
export function getLabelColor(
  label: string, 
  index: number = 0,
  palette: ColorPalette = 'highContrast'
): [number, number, number] {
  
  // First, try anatomical lookup (regardless of palette)
  const normalizedLabel = label.toLowerCase().replace(/[- ]/g, '_');
  if (ANATOMICAL_COLORS[normalizedLabel]) {
    return ANATOMICAL_COLORS[normalizedLabel];
  }
  
  // Fall back to palette-based color
  let colors: [number, number, number][];
  switch (palette) {
    case 'anatomical':
      colors = HIGH_CONTRAST_COLORS; // Fallback for unknown anatomical
      break;
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
  
  return colors[index % colors.length];
}

/**
 * Generate a unique color based on label string hash
 * Ensures same label always gets same color
 */
export function getHashedColor(label: string): [number, number, number] {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    const char = label.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  // Use golden ratio for good distribution
  const goldenRatio = 0.618033988749895;
  const hue = ((hash * goldenRatio) % 1 + 1) % 1;
  
  // Convert HSL to RGB (high saturation & lightness for visibility)
  return hslToRgb(hue, 0.85, 0.55);
}

/**
 * HSL to RGB conversion
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r, g, b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Adjust color brightness
 */
export function adjustBrightness(
  color: [number, number, number], 
  factor: number
): [number, number, number] {
  return [
    Math.min(255, Math.max(0, Math.round(color[0] * factor))),
    Math.min(255, Math.max(0, Math.round(color[1] * factor))),
    Math.min(255, Math.max(0, Math.round(color[2] * factor))),
  ];
}

/**
 * Get contrasting text color (black or white) for a background
 */
export function getContrastingTextColor(bgColor: [number, number, number]): string {
  const luminance = (0.299 * bgColor[0] + 0.587 * bgColor[1] + 0.114 * bgColor[2]) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

// ============================================================================
// OPACITY PRESETS
// ============================================================================

export const OPACITY_PRESETS = {
  solid: 255,        // 100% - Full opacity
  high: 204,         // 80%  - Good for primary structures  
  medium: 153,       // 60%  - Good for overlays
  low: 102,          // 40%  - See-through effect
  veryLow: 51,       // 20%  - Subtle hint
  ultraLow: 25,      // 10%  - Very transparent
};

// ============================================================================
// PRESET CONFIGURATIONS
// ============================================================================

/**
 * Common segmentation configurations
 */
export const SEGMENTATION_PRESETS = {
  // For CT abdominal segmentation
  abdominal: {
    palette: 'anatomical' as ColorPalette,
    opacity: OPACITY_PRESETS.high,
    outlineWidth: 2,
  },
  
  // For lung segmentation
  thoracic: {
    palette: 'anatomical' as ColorPalette,
    opacity: OPACITY_PRESETS.medium,
    outlineWidth: 1,
  },
  
  // For tumor detection
  oncology: {
    palette: 'highContrast' as ColorPalette,
    opacity: OPACITY_PRESETS.solid,
    outlineWidth: 3,
  },
  
  // For brain MRI
  neurological: {
    palette: 'pastel' as ColorPalette,
    opacity: OPACITY_PRESETS.medium,
    outlineWidth: 1,
  },
  
  // For accessibility
  accessible: {
    palette: 'colorblind' as ColorPalette,
    opacity: OPACITY_PRESETS.high,
    outlineWidth: 2,
  },
};

export default {
  ANATOMICAL_COLORS,
  HIGH_CONTRAST_COLORS,
  COLORBLIND_FRIENDLY,
  PASTEL_COLORS,
  RAINBOW_COLORS,
  getLabelColor,
  getHashedColor,
  adjustBrightness,
  getContrastingTextColor,
  OPACITY_PRESETS,
  SEGMENTATION_PRESETS,
};
