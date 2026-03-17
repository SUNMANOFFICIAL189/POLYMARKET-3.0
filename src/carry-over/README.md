# Carry-Over Modules from PATS-Poly

Fetch each file from PATS-Poly repo in the new context window:

```
github:get_file_contents
  owner: SUNMANOFFICIAL189
  repo: pats-poly
  branch: main
  path: <see table below>
```

| PATS-Poly Path | Copy To | Modify? |
|---------------|---------|--------|
| src/signals/glint-scraper.ts | src/signals/glint-scraper.ts | No |
| src/signals/glint-adapter.ts | src/signals/glint-adapter.ts | Simplify |
| src/signals/news-scanner.ts | src/signals/news-scanner.ts | No |
| src/signals/ai-classifier.ts | src/signals/ai-classifier.ts | Modify prompt |
| src/core/risk-manager.ts | src/core/risk-manager.ts | No |
| src/core/config.ts | src/core/config.ts | Simplify |
| src/data/supabase.ts | src/data/supabase.ts | Extend |
| src/execution/cli-wrapper.ts | src/execution/cli-wrapper.ts | No |
| src/utils/logger.ts | src/utils/logger.ts | Rename log file |
| src/types/index.ts | src/types/index.ts | Extend |
| package.json | package.json | Rename |
| tsconfig.json | tsconfig.json | Copy as-is |
