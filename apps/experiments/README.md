# Experiments

This folder is a **safe vibe-coding lane** for experimentation that cannot disrupt the baseline product.

## Purpose

- Try new ideas without affecting the stable extension or backend
- Prototype features before promoting them to the baseline lane
- Test integrations with third-party services
- Build proof-of-concepts

## Guardrails

1. **No production deploy triggers**: CI/CD pipelines ignore this folder
2. **No cross-dependencies**: Experiments should not import from `apps/extension` or `apps/backend` directly
3. **Use contracts**: Experiments CAN import shared types from `packages/contracts`
4. **Use SDK**: Experiments CAN use the typed SDK from `packages/sdk`
5. **Isolation**: Each experiment should be self-contained in its own subfolder

## Structure

```
experiments/
├── README.md           # This file
├── my-experiment/      # Example experiment
│   ├── package.json    # Independent dependencies
│   ├── src/            # Experiment source code
│   └── README.md       # What this experiment does
└── another-idea/       # Another experiment
    └── ...
```

## How to Add a New Experiment

1. Create a new folder: `apps/experiments/your-experiment-name/`
2. Add a `package.json` with its own dependencies
3. Add a `README.md` explaining the experiment's purpose
4. Build and test independently

## How to Promote an Experiment

When an experiment is ready for production:

1. Extract shared types/interfaces to `packages/contracts`
2. Create a PR to add the feature to `apps/extension` or `apps/backend`
3. Archive or delete the experiment folder
4. Update documentation

## Notes

- Experiments are NOT tested in CI (unless explicitly configured)
- Experiments may break at any time
- Do NOT depend on experiments from baseline code
