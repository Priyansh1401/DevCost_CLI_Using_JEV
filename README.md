# DevCost Copilot

CLI-first tools for finding avoidable LLM API spend. This initial scaffold includes:

- `LogScanner`: normalizes JSON/CSV API usage exports and optionally enriches calls with local git history.
- `TokenWasteClassifier`: uses a mockable typed-decision (`JevClient`) interface to identify duplicate prompts and redundant regenerations.
- `CodeArtifactClassifier`: finds files touched by AI-marked commits, gathers reference/blame metadata, and asks Jev whether they are cleanup candidates.
- `CloudStorageClassifier`: classifies S3/GCS-style JSON listing entries and estimates monthly storage savings.
- An in-memory decision log for a future dashboard.

## Quick start

```sh
npm install
npm run dev -- scan --input fixtures/usage-events.json --git-repo .
npm run dev -- classify --input fixtures/usage-events.json --history-size 5 --dry-run
npm run dev -- code-artifacts --repo /path/to/repo --config devcost.config.json --dry-run
npm run dev -- storage --input fixtures/storage-objects.json --dry-run
npm run dev -- report --usage fixtures/usage-events.json --repo /path/to/repo --config devcost.config.json --storage fixtures/storage-objects.json --output devcost-report.json --format table --dry-run
npm test
```

`--dry-run` is accepted by all reporting commands and guarantees no files, source code, git state, or cloud objects are changed. The current modules are read-only in either mode.

## Supported usage-export fields

JSON may contain an array or an object with `events`, `data`, `usage`, or `records`. CSV headers are case-insensitive. Common aliases are accepted:

- prompt: `prompt`, `input`, `input_text`, `request`, `message`
- input tokens: `input_tokens`, `prompt_tokens`, `tokens_in`
- output tokens: `output_tokens`, `completion_tokens`, `tokens_out`
- total tokens: `total_tokens`, `token_count`, `tokens`
- timestamp: `timestamp`, `created_at`, `created`, `time`
- commit: `commit`, `commit_sha`, `git_commit`
- file: `file`, `file_path`, `associated_file`, `path`

The CLI uses the production `JevApiClient` and `ClaudeApiClient`. Set `TYPESAFE_API_KEY` and `ANTHROPIC_API_KEY` in your environment (see [.env.example](.env.example)); Jev requests go directly to TypeSafe's native System One endpoint. Missing keys, request timeouts, rate limits, and invalid API responses return clearly labelled `unclassified` output instead of terminating a scan. Tests continue to inject mock/fixed clients through the same interfaces.

## AI commit configuration

Provide marker terms explicitly in a JSON configuration file. Matching is case-insensitive and a file is inspected only when a git commit subject contains one of the configured markers.

```json
{
  "aiCommitMarkers": ["Copilot", "Codex", "AI-generated"],
  "artifactExclusions": ["package.json", "package-lock.json", "tsconfig.json", "README*", ".gitignore", "*.config.js"]
}
```

`artifactExclusions` uses case-insensitive filename glob patterns and skips matches before metadata collection or classification. If omitted, the listed patterns are the defaults. Add or replace patterns for repository-specific manifests, documentation, or build configuration files.

The `code-artifacts` and `storage` commands print a readable candidate table followed by the complete JSON report. A Jev confidence from `0.5` (inclusive) to `0.7` (exclusive) triggers the injected `LlmClient` one-line review; these mocks never delete anything.

## Unified reports

`report` runs all four modules. It always writes the full JSON report to `--output` (default: `devcost-report.json`); `--format table|json` controls the console summary. The decision breakdown separately reports Jev-only decisions, Claude escalations, and unclassified fallbacks. The Jev resolution rate excludes unclassified calls from its denominator.

`--repo` must be the local path of an already cloned Git repository. URLs such as `https://github.com/org/repo.git` and `git@github.com:org/repo.git` are rejected before the CLI invokes Git.
