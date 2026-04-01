# Contributing to OpenCeph

OpenCeph welcomes contributions to the core runtime, documentation, and the `skill_tentacle` ecosystem. This repository is released under the MIT License, and contributions submitted here are accepted under that same license.

This guide is intentionally practical. It explains how to contribute to OpenCeph. It is not a full architecture reference.

## Project Fit

OpenCeph is a proactive AI personal operating system, not a simple chat assistant. The project is built around a long-running Brain, multi-channel delivery, and autonomous tentacles that monitor, analyze, and report over time.

The main contribution surfaces are:

- **Core**: runtime reliability, Brain and Gateway behavior, memory, push, scheduling, tentacle lifecycle, and developer tooling
- **Docs**: README, guides, examples, onboarding, and public-facing template wording
- **`skill_tentacle` ecosystem**: new tentacles, improvements to existing tentacles, and better packaging/deployment guidance

Plugin and extension-channel contributions are also possible, but they are not the primary launch path covered by this document.

## Before You Contribute

Start with [README.md](README.md). It explains what OpenCeph is, what is already shipped, and how the repository is intended to be used.

For deeper specs and implementation guidance, use the existing docs instead of treating this file as the source of truth:

- [docs/skill-tentacle-guide.md](docs/skill-tentacle-guide.md)
- [docs/skill-package-guide.md](docs/skill-package-guide.md)
- [docs/extension-channel-guide.md](docs/extension-channel-guide.md)

Open-source hygiene matters. Do not commit:

- runtime data, local logs, caches, secrets, or build artifacts
- personalized workspace content, private memory snapshots, or real-user profile defaults
- template text that encodes a specific person's identity, history, preferences, or internal operating context

If you are updating templates or examples, keep them generic, reusable, and safe for public distribution.

## Contribution Types

### Core

Core contributions include bug fixes and improvements across the runtime:

- Brain and Gateway behavior
- channel integrations
- memory and search
- push and scheduling
- tentacle lifecycle and health management
- CLI and developer tooling

### Docs

Docs contributions include:

- README and setup guidance
- reference guides and examples
- contributor-facing instructions
- wording changes that make the project clearer and more suitable for a public open-source audience

When updating docs, keep claims aligned with what is actually implemented in the repository today.

### `skill_tentacles`

`skill_tentacle` contributions are welcome for both new packages and improvements to existing ones. These should follow the published package and protocol guidance rather than inventing a parallel format.

## Development Setup

OpenCeph currently targets **Node >=22**.

Minimal local setup:

```bash
npm install
npm run build
npm test
```

Use [README.md](README.md) for runtime bootstrapping, initialization, and local service startup details.

## Quality Bar

Keep pull requests focused and easy to review.

- Explain the problem being solved, not just the code change.
- Add or update tests when behavior changes and test coverage is practical.
- Update docs when user-facing behavior, contributor workflows, or public interfaces change.
- Do not document planned features as if they are already shipped.
- Use English and community-neutral wording in public docs, examples, prompts, and templates added for open-source release.

If a change is intentionally partial, say so clearly in the PR description.

## `skill_tentacle` Submission Rules

At minimum, a `skill_tentacle` contribution should include:

- `SKILL.md`
- `README.md`
- `prompt/SYSTEM.md`
- runtime entry code and declared dependencies

Submissions should also:

- align with the published skill-tentacle spec and IPC/runtime contracts
- document setup steps and required environment variables
- include a dry-run, test path, or other concrete verification method

If a tentacle depends on external services, the README should make those dependencies explicit.

## Pull Request Process

For large architectural changes, protocol changes, or changes that affect contributor workflows, open an issue or discussion first.

Each pull request should clearly state:

- what changed
- why it changed
- how it was verified
- what limitations, follow-up work, or known gaps remain

Prefer one concern per PR. Smaller, well-scoped pull requests are easier to review and merge.

## MIT Licensing Note

By submitting code, documentation, prompts, templates, or other assets to this repository, you agree that your contribution will be provided under the repository's MIT License.

This project does not add a separate CLA or DCO requirement in this pass.

## Where to Ask

If you are unsure whether a change fits the project, open an issue or start the conversation in a pull request. For non-trivial work, asking early is better than sending a large speculative patch.
