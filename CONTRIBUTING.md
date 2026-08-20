# Contributing to Medical Imaging Platform

Thank you for your interest in contributing to the Medical Imaging Platform! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Pull Request Process](#pull-request-process)
- [Issue Guidelines](#issue-guidelines)

---

## Code of Conduct

### Our Pledge

We are committed to providing a welcoming and inclusive environment for all contributors. We pledge to:

- Be respectful and considerate of differing viewpoints
- Accept constructive criticism gracefully
- Focus on what is best for the community
- Show empathy towards other community members

### Unacceptable Behaviour

- Harassment, discrimination, or offensive comments
- Personal or political attacks
- Publishing others' private information without consent
- Other conduct that would be inappropriate in a professional setting

## Getting Started

### Prerequisites

- **Docker Desktop** 4.0+
- **Node.js** 22+ and **Yarn** 1.22+
- **Python** 3.12+
- **Git** 2.30+

### Setting Up the Development Environment

```bash
# Fork and clone
git clone https://github.com/YOUR_USERNAME/uncertainty-annotation-apparatus.git
cd uncertainty-annotation-apparatus

# Set up environment
cp .env.example .env
# Edit .env with your PostgreSQL password

# Start core services
docker compose up -d

# Install OHIF dependencies
cd ohif-viewer
yarn install

# Create a branch for your work
git checkout -b feature/my-contribution
```

## How to Contribute

### Areas for Contribution

1. **New evaluation conditions** — Add new conditions to the C0–C5 factorial design (see [Developer Guide](DEVELOPER_GUIDE.md#adding-a-new-condition))
2. **MONAI Label inference tasks** — New segmentation backbones or uncertainty methods (deep ensembles, test-time augmentation)
3. **Calibration methods** — Additional calibration techniques (isotonic regression, beta calibration)
4. **OHIF viewer improvements** — Better heatmap rendering, additional panels, keyboard shortcuts
5. **Analysis scripts** — New statistical analyses for the evaluation data
6. **Documentation** — Bug fixes, tutorials, translation
7. **Bug fixes** — See the [issue tracker](https://github.com/BSeeTech/uncertainty-annotation-apparatus/issues)

### What We Cannot Accept

- Clinical certification work — this is a research prototype, not a medical device
- Full HIPAA compliance patches — the scope is explicitly non-clinical
- New deep learning model training pipelines — we use pretrained models only

## Development Workflow

### 1. Server-Side Changes (Python/FastAPI)

```bash
cd servers/uncertainty-service
# Make your changes
python -m pytest -v  # Run tests
```

**Key files:**
- `app/main.py` — All API endpoints and condition routing
- `app/analysis/` — Calibration metrics and temperature scaling
- `app/scoring.py` — NIfTI-based uncertainty scoring

### 2. Client-Side Changes (TypeScript/React)

```bash
cd ohif-viewer
# Make your changes
npx jest --testPathPattern='extension-uncertainty'  # Run extension tests
```

**Key files:**
- `extensions/extension-uncertainty/src/` — Services, panels, types
- `modes/uncertainty-review/src/` — Mode lifecycle, commands, adapters

### 3. Condition Changes

If adding or modifying evaluation conditions, update ALL of:

1. `ohif-viewer/extensions/extension-uncertainty/src/types.ts` — Condition type
2. `servers/uncertainty-service/app/main.py` — Task routing map
3. `ohif-viewer/modes/uncertainty-review/src/commands/openUncertaintyCase.ts` — Plan builder
4. `ohif-viewer/modes/uncertainty-review/src/sessionConfig.ts` — Valid conditions
5. Panel gating in `PanelUncertainty.tsx`, `PanelWorklist.tsx`, `PanelSubmission.tsx`

### 4. Documentation Changes

Update the relevant `.md` file in the root directory. All documentation is in Markdown.

## Coding Standards

### Python

- **Format**: Use `black` with default settings
- **Types**: Use type hints for all function signatures
- **Imports**: Standard library → third-party → local, separated by blank lines
- **Tests**: `pytest` with async support; fixtures in `conftest.py`
- **Docstrings**: Google-style for public functions

### TypeScript

- **Format**: Use the project's Prettier config
- **Types**: Avoid `any`; use proper type imports
- **Naming**: `camelCase` for variables/functions, `PascalCase` for types/components
- **Tests**: Jest with `@testing-library/react`; use `data-testid` attributes
- **State**: Use the shared `UncertaintyService` bus, not local React state, for cross-component state

### Git

- **Branch names**: `feature/description`, `fix/description`, `docs/description`
- **Commit messages**: Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`)
- **One commit per logical change** — squash before merging

## Testing Guidelines

All contributions must maintain or improve test coverage.

### Server-Side

```bash
# Run all uncertainty service tests
cd servers/uncertainty-service
python -m pytest -v --tb=short

# Run with coverage
python -m pytest --cov=app --cov-report=term-missing

# Run specific test categories
python -m pytest -k "calibration"
python -m pytest tests/test_scoring.py
```

### Client-Side

```bash
# Run extension tests
cd ohif-viewer
npx jest --testPathPattern='extension-uncertainty' --coverage

# Run mode tests
npx jest --testPathPattern='uncertainty-review'

# Run all tests
npx jest --testPathPattern='extension-uncertainty|uncertainty-review'
```

### When to Write Tests

- **Always** for new API endpoints
- **Always** for new condition paths
- **Always** for new services (SnapshotService, etc.)
- **Always** for bug fixes (regression test first)
- **Optional** for UI-only changes if the change is visually verified

## Pull Request Process

### Before Submitting

1. **Run the full test suite** — Ensure nothing is broken
2. **Update documentation** — README, API docs, relevant guides
3. **Update CHANGELOG.md** — Add your change under "Unreleased"
4. **Rebase on main** — `git rebase main`
5. **Squash commits** — One commit per logical change

### PR Template

```markdown
## Description
Brief description of the change.

## Type of Change
- [ ] Bug fix
- [ ] New feature (condition, service, analysis)
- [ ] Documentation update
- [ ] Refactor / performance
- [ ] Test improvement

## Testing
- [ ] Server-side tests pass
- [ ] Client-side tests pass
- [ ] Manual testing completed

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
- [ ] No new warnings introduced

## Related Issues
Closes #...
```

### Review Process

1. A maintainer will review within 1 week
2. Address all review comments
3. Once approved, a maintainer will merge

## Issue Guidelines

### Bug Reports

Include:
- Platform version / commit hash
- Steps to reproduce
- Expected vs. actual behaviour
- Screenshots or logs
- Browser and OS (for UI bugs)

### Feature Requests

Include:
- What problem does it solve?
- How would it be used?
- Does it affect the condition system or uncertainty workflow?

### Questions

Search existing issues and documentation before opening a new one. Use GitHub Discussions for open-ended questions.
