# User Guide

A comprehensive guide for using the Uncertainty Annotation Apparatus (UAA).

## Table of Contents

- [Getting Started](#getting-started)
- [Workflow Conditions](#workflow-conditions)
- [The Uncertainty Worklist](#the-uncertainty-worklist)
- [Reading the Heatmap](#reading-the-heatmap)
- [Annotation Tools](#annotation-tools)
- [Making Decisions](#making-decisions)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Best Practices](#best-practices)

---

## Getting Started

### Accessing the Platform

1. Open your web browser (Chrome, Firefox, or Edge recommended)
2. Navigate to: **http://localhost:3000**
3. Append the reviewer and condition to the URL:
   ```
   http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2
   ```

### First-Time Setup

When you first open the platform, you'll see:
- **Left panel**: The Uncertainty Worklist showing available cases
- **Centre**: The image viewport (initially blank until you select a case)
- **Right panel**: Uncertainty Controls and Submission panel

The reviewer ID (`R01`, `R02`, etc.) tags your annotations. The condition (`C0`–`C5`) determines what AI assistance you receive.

---

## Workflow Conditions

The platform supports six conditions that control the level of AI assistance. The condition is fixed per session — switch it in the URL only when starting a new session block.

| Condition | AI Help? | Heatmap? | Worklist Order | You Should… |
|-----------|----------|----------|---------------|-------------|
| **C0** | ❌ No AI | ❌ No | By arrival | Draw the segmentation entirely from scratch |
| **C1** | ✅ AI mask | ❌ No | By arrival | Check the AI mask; edit where wrong, accept where correct |
| **C2** | ✅ AI mask | ✅ Entropy colours | Highest uncertainty first | Use the heatmap to find problem areas faster |
| **C3** | ✅ AI mask | ✅ Edge overlay | Highest uncertainty first | Same UI as C2, but the "heatmap" shows edges |
| **C4** | ✅ AI mask | ❌ No | Highest uncertainty first | Review hardest cases first, no heatmap |
| **C5** | ✅ AI mask | ✅ Entropy colours | Random order | Use the heatmap; cases appear in random sequence |

> **Tip:** Do not switch conditions in the middle of a session block — the condition is recorded per session and mixing them makes the session logs ambiguous.

---

## The Uncertainty Worklist

The worklist panel (left side) shows all available cases for review:

```
┌──────────────────────────────┐
│  🔬 Uncertainty Worklist      │
│  ┌──────────────────────────┐ │
│  │ Policy: [High first  ▼]  │ │
│  │ [🔄 Refresh]              │ │
│  ├──────────────────────────┤ │
│  │ Case_001   Score: 0.42   │ │
│  │           Band: MEDIUM 🔶 │ │
│  ├──────────────────────────┤ │
│  │ Case_002   Score: 0.87   │ │
│  │           Band: HIGH 🔴   │ │
│  ├──────────────────────────┤ │
│  │ Case_003   Score: 0.12   │ │
│  │           Band: LOW 🟢    │ │
│  └──────────────────────────┘ │
└──────────────────────────────┘
```

- **Score**: Mean foreground entropy (0 = fully confident, higher = more uncertain)
- **Band**: LOW 🟢 / MEDIUM 🟡 / HIGH 🔴 — quick triage
- **Policy**: Change the ordering (hidden in C0/C1/C5)
- In C0/C1/C5, cases appear in FIFO or random order (score column hidden)

Click any row to open that case for review.

---

## Reading the Heatmap

When a heatmap is visible (C2, C3, C5), it appears as a semi-transparent colour overlay on the AI segmentation:

| Colour | Meaning | What to Do |
|--------|---------|------------|
| 🟢 **Green** | Low uncertainty — model is confident | Likely correct; quick visual check |
| 🟡 **Yellow/Amber** | Medium uncertainty | Inspect more carefully |
| 🔴 **Red** | High uncertainty — model is unsure | Prioritise for detailed review and potential correction |

### Important Notes

- **Boundary saliency**: High uncertainty often concentrates at organ boundaries. This is normal — boundaries are inherently ambiguous.
- **C3 (placebo)**: The "heatmap" shows Sobel edge magnitude, not actual uncertainty. It will look similar to C2 but does not convey information about model confidence.
- **False confidence**: The AI can be confidently wrong (green but incorrect). Always use your expert judgment.

### Adjusting the Heatmap

Use the Uncertainty Controls panel (bottom-right):
- **Toggle visibility**: Click the eye icon or press `h`
- **Opacity slider**: Adjust how much the heatmap shows through
- The heatmap updates as you scroll through slices

---

## Annotation Tools

The platform provides standard OHIF segmentation tools:

| Tool | Icon | Shortcut | Use For |
|------|------|----------|---------|
| **Brush** | 🖌️ | `B` | Painting segmentation regions |
| **Smart Scissors** | ✂️ | `S` | Semi-automatic boundary tracing |
| **Threshold** | 📊 | `T` | Intensity-based region growing |
| **Eraser** | 🧹 | `E` | Removing parts of a segmentation |
| **Undo** | ↩️ | `Ctrl+Z` | Undo last edit |
| **Redo** | ↪️ | `Ctrl+Shift+Z` | Redo undone edit |

---

## Making Decisions

### The Submission Panel

```
┌──────────────────────────────┐
│  📄 Submission                │
│                              │
│  [✓ Accept] [✏️ Edit] [✗ Rej] │
│                              │
│  Status: In Review            │
└──────────────────────────────┘
```

- **Accept** (C1–C5 only) — The AI mask is correct. Submits once.
- **Edit** — You made changes to the mask. Sends the edited mask to the server.
- **Reject** — The AI mask is unusable (e.g., wrong organ, failed inference).

In **C0 (manual)**, the Accept button is disabled because there is no AI mask.

### Persistence

After submitting, your annotation is stored in the database. If you close the case and reopen it, you'll see your previous annotation with a new AI mask overlay.

---

## Keyboard Shortcuts

| Shortcut | Action | Available In |
|----------|--------|-------------|
| `B` | Brush tool | All conditions |
| `S` | Smart scissors | All conditions |
| `E` | Eraser | All conditions |
| `T` | Threshold tool | All conditions |
| `Ctrl+Z` | Undo | All conditions |
| `Ctrl+Shift+Z` | Redo | All conditions |
| `A` | Accept AI mask | C1–C5 |
| `R` | Reject AI mask | C1–C5 |
| `H` | Toggle heatmap | C2, C3, C5 |
| `→` | Next case | All conditions |
| `←` | Previous case | All conditions |

---

## Best Practices

### For Accurate Annotations

1. **Always scroll through all slices** — Don't rely on a single view
2. **Check the heatmap first** (C2/C5) — Red regions likely need attention
3. **Be systematic** — Review in a consistent order (e.g., top-to-bottom)
4. **Don't over-correct** — If the AI is already correct in green regions, leave it
5. **Use the right tool** — Brush for large regions, scissors for boundaries

### For Consistent Session Data

1. **Use the same reviewer ID** throughout your sessions
2. **Complete all cases** in each condition block
3. **Don't use the browser back button** — Use the worklist to navigate
4. **If something breaks**, note the error and restart the session from the worklist
5. **Report confusing heatmap patterns** — They help improve the system

### Performance Tips

- The heatmap rendering uses GPU via Cornerstone3D
- For large volumes, wait for the spinner to clear before editing
- If the viewer feels slow, reduce the heatmap opacity
