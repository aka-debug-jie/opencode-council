---
name: codex-council
description: Run a bounded OpenCode Go council when the user explicitly asks to "开个 council", "quick council", "critical council", or requests a second-opinion council for an architecture decision, high-risk change, or material requirement ambiguity. Create a concise brief, invoke the local sidecar, and retain final judgment and implementation in the current Codex task.
---

# Codex Council

Use only for an explicit council request. Do not invoke automatically or delegate the main task.

1. Choose rounds: `quick` = 1, ordinary = 2, `critical` = 3.
2. Build a Council Brief of at most 16,000 characters from the current task and relevant repository evidence. Include Decision, Context, Constraints, Options, Current hypothesis, Uncertainties, Relevant files, and a request for assumptions, risks, minority views, and falsification tests. Do not copy the full conversation or write the brief into the project.
3. Pipe the brief to `scripts/run_council.sh --project-dir "$PWD" --rounds <1|2|3>`.
4. Treat stdout as advisory Council Report. If the runner fails, report the exact concise error and continue the main task without a council result; do not retry automatically.
5. State the final decision yourself. Explicitly assess disagreement, minority views, falsification tests, and risks missed by the current hypothesis before continuing the original task.

The sidecar coordinator is GPT 5.6 Luna and has no authority to make the final recommendation. Muse Spark 1.3 Contributor, Qwen 3.8 Flash, and GLM 5.3 Flash are the three read-only participants. HY4 Preview is a reserve rotation candidate, not a fourth participant. The runner allows 300 seconds per configured round unless `CODEX_COUNCIL_TIMEOUT_SECONDS` explicitly overrides it.

The repository copy of this skill is the maintained source. Install it with `python3 scripts/install-council-skill.py` from the opencode-council checkout; use `--check` to compare installed managed files without writing. The installer leaves unrelated files and configuration alone.

The runner uses the checkout at `$HOME/Desktop/codexapp/opencode-council` and its bundled Node 24 by default; set `COUNCIL_CHECKOUT` and `COUNCIL_NODE` for a different installation. Each invocation creates a new run ID and deadline. Persistent metadata lives under `${XDG_STATE_HOME:-~/.local/state}/opencode-council` (or `COUNCIL_STATE_DIR`), without discussion text. Do not reset or edit this ledger to bypass a rejected continuation. A report is accepted only after all configured participant rounds are validated and the latest assistant stops normally; missing, corrupt, aborted, or incomplete state fails closed.
