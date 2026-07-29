# Cross-platform v1.5.0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the current production code as v1.5.0, provide a tested Windows installer, and make update downloads platform-aware without shipping local user data or caches.

**Architecture:** Keep application resources inside the source tree or PyInstaller bundle, while storing mutable data, logs, generated images, models, and backups in an OS-specific user-data directory for frozen builds. Use GitHub Actions Windows runners to execute tests, build a one-folder PyInstaller application, wrap it with Inno Setup, and publish checksummed assets. Source installs update in place; packaged installs download and launch the correct platform installer.

**Tech Stack:** Python 3.11, Flask, pywebview, PyInstaller, Inno Setup, GitHub Actions, pytest.

---

### Task 1: Curate the production source snapshot

**Files:** `.gitignore`, `.gitattributes`, `app.py`, `desktop_app.py`, `requirements.txt`, `templates/`, `static/css/`, `static/js/`, `default_data/`, `tests/`

1. Copy only executable source, UI resources, clean defaults, documentation, and tests from the running project.
2. Remove tracked runtime `data/` and generated `static/images/` content from the release tree.
3. Expand ignore rules for caches, logs, outputs, backups, models, secrets, and build artifacts.
4. Run a tracked-file privacy scan and verify no credential-bearing local config is staged.

### Task 2: Make runtime storage and OS integrations portable

**Files:** `app.py`, `desktop_app.py`, `tests/test_platform_support.py`

1. Add failing tests for frozen Windows/macOS data locations and resource locations.
2. Implement resource and user-data directory resolution.
3. Initialize clean defaults on first packaged launch and keep source-mode behavior compatible.
4. Add platform helpers for opening paths, selecting folders, moving files to trash, and file clipboard behavior.
5. Add Windows-aware storage path validation and temporary-file handling.
6. Run focused and full unit tests.

### Task 3: Repair platform-aware updates

**Files:** `app.py`, `tests/test_update_system.py`, `version.json`

1. Add failing tests for semantic version comparison and OS-specific Release asset selection.
2. Select macOS source ZIP, macOS installer, or Windows installer according to runtime mode.
3. Require SHA-256 sidecar verification instead of silently accepting missing or bad checksums.
4. Preserve only mutable user content during source updates while allowing JS/CSS to update.
5. For packaged installs, download the verified installer and launch it outside the current process.
6. Set the version to 1.5.0 and run focused tests.

### Task 4: Build and test on Windows CI

**Files:** `packaging/windows/样片工厂.spec`, `packaging/windows/installer.iss`, `scripts/validate_release_tree.py`, `.github/workflows/release.yml`

1. Define a Windows PyInstaller build containing templates, CSS, JS, defaults, and required hidden imports.
2. Define a per-user Inno Setup installer with upgrade support and shortcuts.
3. Add a release-tree validator that rejects caches, mutable data, generated images, models, logs, outputs, and likely secrets.
4. Configure Windows CI to install dependencies, run unit tests, build, install silently, launch a packaged smoke test, and publish installer plus checksums.
5. Configure source ZIP generation from an explicit allowlist.

### Task 5: Verify and publish

**Files:** all release files

1. Run Python compilation, JSON validation, unit tests, Flask test-client smoke checks, and the privacy scanner in the isolated clone.
2. Review the staged diff and tracked-file list.
3. Commit and push main.
4. Create tag v1.5.0 so GitHub Actions builds and publishes the Release.
5. Wait for Windows CI success, download the published Windows artifact, verify SHA-256, and copy it into `/Volumes/外置固态/Windows样片工厂`.
