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

The reviewer ID (`R01`, `R02`, etc.) tags your annotations. The condition (`C0`–`C2`) determines what AI assistance you receive.

---

## Workflow Conditions

The platform supports three implemented conditions that control the level of AI assistance (C0–C2). The condition is fixed per session — switch it in the URL only when starting a new session block.

| Condition | AI Help? | Heatmap? | Worklist Order | You Should… |
|-----------|----------|----------|---------------|-------------|
| **C0** | ❌ No AI | ❌ No | By arrival | Draw the segmentation entirely from scratch |
| **C1** | ✅ AI mask | ❌ No | By arrival | Check the AI mask; edit where wrong, accept where correct |
| **C2** | ✅ AI mask | ✅ Entropy colours | Highest uncertainty first | Use the heatmap to find problem areas faster |

> **C3–C5 are gated scaffolding, not usable conditions.** The six-arm `Condition`
> type, client plan computation, and MONAI Label `saliency_placebo` task exist, but the
> server rejects inference for C3–C5 (HTTP 400), no test exercises them, and the
> worklist ordering is not selectable per condition. Sessions should use C0–C2.

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
- **Policy**: Ordering is fixed to the default (highest uncertainty first) in every implemented condition

Click any row to open that case for review.

---

## Reading the Heatmap

When a heatmap is visible (C2), it appears as a semi-transparent, sequential
`magma` colour overlay on the AI segmentation:

| Appearance | Meaning | What to Do |
|---|---|---|
| **Black/deep purple** | Lower predictive entropy | Check normally; low entropy does not guarantee correctness |
| **Magenta/orange** | Intermediate predictive entropy | Inspect carefully |
| **Cream/yellow** | Higher predictive entropy | Prioritise for detailed review |

### Important Notes

- **Boundary saliency**: High uncertainty often concentrates at organ boundaries. This is normal — boundaries are inherently ambiguous.
- **Not an error map**: High entropy is not proof of an error, and low entropy is
  not proof of correctness. Always use your expert judgment.

### Adjusting the Heatmap

Use the Uncertainty Controls panel (bottom-right):
- **Toggle visibility**: Use the panel control or press `u`
- **Opacity slider**: Adjust how much the heatmap shows through
- The heatmap updates as you scroll through slices

---

## Annotation Tools

The platform provides standard OHIF segmentation tools:

| Tool | Use For |
|---|---|
| **Brush** | Painting segmentation regions |
| **Smart Scissors** | Semi-automatic boundary tracing |
| **Threshold** | Intensity-based region growing |
| **Eraser** | Removing parts of a segmentation |

Select tools from the OHIF toolbar. Upstream OHIF shortcuts can vary by viewer
version and deployment, so rely on the labels shown in the running viewer.

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

- **Accept** (C1/C2 only) — The AI mask is correct. Submits once.
- **Edit** — You made changes to the mask. Sends the edited mask to the server.
- **Reject** — The AI mask is unusable (e.g., wrong organ, failed inference).

In **C0 (manual)**, the Accept button is disabled because there is no AI mask.

### Persistence

After submission, the annotation record and stored mask URL are persisted by the
uncertainty service. Do not assume that reopening a case restores an unfinished
local edit; submit before leaving the case.

---

## Keyboard Shortcuts

| Shortcut | Action | Available In |
|----------|--------|-------------|
| `A` | Accept AI mask | C1/C2 |
| `R` | Reject AI mask | C1/C2 |
| `U` | Toggle heatmap | C2 |
| `Shift+U` | Refresh worklist | All conditions |

---

## Best Practices

### For Accurate Annotations

1. **Always scroll through all slices** — Don't rely on a single view
2. **Use the heatmap to focus attention** (C2) - brighter regions have higher predictive entropy
3. **Be systematic** — Review in a consistent order (e.g., top-to-bottom)
4. **Don't over-correct** - edit based on the anatomy, not the heatmap colour alone
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
