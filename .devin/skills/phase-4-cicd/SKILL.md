# Skill Domain: Phase 4 — CI/CD Pipeline Enhancement

## Context

The repo already has two GitHub Actions workflows:
- `.github/workflows/ci.yml` — runs server, dashboard, agent tests on push/PR
- `.github/workflows/release.yml` — builds + publishes agent binaries and Electron apps on tag push

This phase enhances CI/CD with linting, security scanning, dependency management, and caching improvements.

## Current State

### ci.yml
- 3 jobs: server-tests, dashboard-tests, agent-tests
- Uses Node 20, Python 3.12
- npm ci for reproducible installs
- No linting step
- No security scanning
- No dependency caching for Python (only pip cache)

### release.yml
- Test job runs all 3 test suites before building
- Agent binaries built on 4 platforms (windows-x64, linux-x64, darwin-x64, darwin-arm64)
- Electron apps built per-platform
- macOS builds per-arch with manifest merging
- No linting before build
- No SAST/DAST scanning

## Research Findings

### Linting
- **Server**: No linter configured. Should add ESLint with security plugin (`eslint-plugin-security`)
- **Dashboard**: No linter configured. Should add ESLint with React plugins
- **Agent**: No linter configured. Should add `ruff` or `pylint` with security rules
- **Workflows**: Should add `actionlint` for workflow validation

### Security Scanning
- **npm audit**: Run `npm audit --audit-level=high` in CI
- **pip-audit**: Run `pip-audit` on agent requirements
- **Trivy**: Container image scanning for Dockerfile.server
- **CodeQL**: GitHub's semantic code analysis (free for public repos)

### Dependency Management
- **Dependabot**: Auto-update dependencies with config file
  - npm (server, dashboard, electron) — weekly
  - pip (agent) — weekly
  - GitHub Actions — weekly
- **Renovate**: Alternative to Dependabot, more configurable

### Caching Improvements
- Python: `actions/setup-python` with `cache: pip` already present
- Node: `actions/setup-node` with `cache: npm` already present
- Electron: Could cache `~/.cache/electron-builder` and `~/.electron`
- PyInstaller: Could cache `agent/build/` directory

### CI Workflow Best Practices
1. **Fail fast**: Linting should run before tests (faster feedback)
2. **Parallel jobs**: Lint + test can run in parallel if lint doesn't modify files
3. **Concurrency control**: Cancel in-progress runs on new pushes to same branch
4. **Path filtering**: Only run affected component tests when files change
5. **Artifact upload**: Upload test results and coverage reports

## Reasoning Questions

1. **Should linting fail the build or just warn?**
   - Answer: Fail. Linting that doesn't block is ignored. Start with reasonable rules and tighten over time.

2. **Should we use CodeQL or a third-party SAST tool?**
   - Answer: CodeQL. It's free for public repos, integrates natively with GitHub, and covers JavaScript + Python. Add it as a separate workflow.

3. **Should Dependabot auto-merge or just create PRs?**
   - Answer: Create PRs only. Auto-merging dependencies without review is risky, especially for security-sensitive code. Group minor/patch updates to reduce noise.

4. **Should path filtering use `paths` or `dorny/paths-filter`?**
   - Answer: Use `dorny/paths-filter` action. Native `paths` cancels the entire workflow if no paths match, which breaks required status checks. `dorny/paths-filter` allows conditional job execution within a single workflow.

5. **Should we add concurrency cancellation?**
   - Answer: Yes. Cancel previous runs when new commits are pushed to the same branch. Saves CI minutes and avoids stale results.

## Implementation Guidelines

### .github/workflows/lint.yml
- Trigger: push + PR
- Jobs:
  - `lint-server`: ESLint on `server/src/` + `server/tests/`
  - `lint-dashboard`: ESLint on `dashboard/src/` + `dashboard/tests/`
  - `lint-agent`: ruff on `agent/*.py` + `agent/tests/`
  - `lint-workflows`: actionlint on `.github/workflows/`
- Each job runs in parallel
- Fail on any lint error

### .github/dependabot.yml
- `npm` ecosystem: `/server`, `/dashboard`, `/electron` — weekly, group minor+patch
- `pip` ecosystem: `/agent` — weekly
- `github-actions` ecosystem: `/` — weekly
- Ignore major updates (manual review required)

### ci.yml enhancements
- Add `concurrency` block to cancel stale runs
- Add `npm audit` step to server-tests and dashboard-tests
- Add `pip-audit` step to agent-tests
- Add `dorny/paths-filter` for conditional job execution
- Upload test results as artifacts

### ESLint configs
- `server/.eslintrc.json` — `eslint:recommended` + `eslint-plugin-security`
- `dashboard/.eslintrc.json` — `eslint:recommended` + React plugins
- Agent: `agent/ruff.toml` or `agent/pyproject.toml` with ruff config

## File Boundaries
- CREATE: `.github/workflows/lint.yml`, `.github/dependabot.yml`
- EDIT: `.github/workflows/ci.yml` (add concurrency, security scanning, path filtering)
- CREATE: `server/.eslintrc.json`, `dashboard/.eslintrc.json`, `agent/ruff.toml`
- DO NOT EDIT: `.github/workflows/release.yml` (Phase 5 will touch it for signing)
