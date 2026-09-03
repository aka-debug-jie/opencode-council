# opencode-council

Private, bounded three-model council plugin for OpenCode. It is derived from [DrTralala/opencode-debate v2.2.2](https://github.com/DrTralala/opencode-debate/tree/v2.2.2) and retains its MIT licence.

## Safety boundary

- MiMo, Qwen, and DeepSeek are neutral read-only participants.
- `/council` and compatible `/debate` run two rounds by default; `--rounds 1`, `2`, or `3` are the only accepted values.
- A council has at most 12 participant dispatches, five participant steps each, two formatting corrections per participant/round, and 8,000 characters per canonical turn.
- Participants cannot edit, use bash, access the web, ask questions, create tasks, invoke skills, or read `.env` files.
- A safety abort ends the transcript with `## Council Abort`; it never synthesises incomplete evidence.

## Development

This repository requires Node 24.15.0 (`.node-version`) and Python 3. Install dependencies and verify:

```bash
npm ci
sh scripts/verify.sh
```

The packaged configuration currently uses `opencode-go/mimo-v2.5-pro`, `opencode-go/qwen3.7-max`, and `opencode-go/deepseek-v4-pro`, confirmed by `opencode models --refresh` on this host. Refresh models again on another target machine before use and update `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode-council/config.yaml` if its catalog differs.

## Installation and rollback

After private publication, pin the exact release in OpenCode:

```json
{ "plugin": ["@aka-debug-jie/opencode-council@0.1.0"] }
```

To roll back, replace that entry with `opencode-debate@2.2.2` and restart OpenCode. Council transcripts are written locally under `docs/debates/`; `docs/` is intentionally ignored.
