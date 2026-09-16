# skillforge

Local workbench for discovering, composing, versioning and evaluating agent skills. Every comparison carries a frozen no-skill baseline.

Most skill repos tell you a skill works. None show the run where the same model on the same case without the skill did as well. skillforge is the tool I wanted for that question. It keeps a local catalog of skill packs (18 bundled, plus anything you import from a `SKILL.md`, a folder or a catalog). It composes new packs deterministically from a task description. Every revision gets an immutable identity, so results never transfer between versions unnoticed. An evaluation freezes the model, conditions, candidates, rubric and cases before you see one output, and always includes the no-skill baseline. You run the frozen prompts in your own host and submit the real outputs and judgments. The report gives baseline deltas with completeness and requirement checks, or refuses to pick a winner while evidence is missing.

It never calls a model itself. Search scores are heuristics and the report says so. Synthetic fixtures must be marked `demo` and stay separate from observed evidence.

## Quick start

Node 22 or newer.

```sh
npm ci
node agent/cli.mjs commands                                   # 19 operations with input schemas
node agent/cli.mjs init --workspace /absolute/path/skills     # explicit; never created implicitly
node agent/cli.mjs setup --workspace /absolute/path/skills    # prints an MCP server config
node agent/cli.mjs ui --workspace /absolute/path/skills       # optional review UI on loopback
```

Operations take JSON on `--input file.json` or stdin and answer `{ ok, data | error }`. Mutations carry `expectedRevision` and are rejected when stale. `--output` never overwrites a file. `--read-only` drops the mutating tools from the MCP server.

The evaluation loop is `evaluation.create`, then `evaluation.prompt` per candidate, case and repetition, then `evaluation.submit`, then `evaluation.report`. `skills/skillforge-workflow/SKILL.md` is the version an agent reads.

`npm test` runs 59 tests.

## What it produces

- A `state.json` workspace, written atomically, holding skills, revisions, collections and evaluations.
- Inert skill ZIPs from `skill.export`: `SKILL.md`, resources, manifest and integrity hashes, never installed anywhere.
- Evaluation reports with per-candidate deltas against the baseline, provenance for executor, environment and judge, and an explicit list of what is still unknown.
- Private backups that include prompts and outputs, restorable only after a dry-run preview.

## In the suite

skillforge is one of three tools in [fieldpack](https://github.com/ong6/fieldpack), beside [deckforge](https://github.com/ong6/deckforge) and [proofpack](https://github.com/ong6/proofpack). The bundled catalog here is what [skillpack](https://github.com/ong6/skillpack) publishes.

## More from ong6

Forges make things, packs bundle them.

- [groundplane](https://github.com/ong6/groundplane) — fails the build when an agent asserts a fact its tools never produced
- [jobforge](https://github.com/ong6/jobforge) — grades the interview plan you say out loud, not the code you submit
- [deckforge](https://github.com/ong6/deckforge) — agent-first presentation studio with a measured preflight
- [proofpack](https://github.com/ong6/proofpack) — pilot evidence, review proposals and customer-safe handovers
- [fieldpack](https://github.com/ong6/fieldpack) — deckforge, skillforge and proofpack as one local-first suite
- [skillpack](https://github.com/ong6/skillpack) — the Claude Code and Codex skills used across all of these
- [uipack](https://github.com/ong6/uipack) — React and SVG figure components behind the diagrams on junxiong.dev
