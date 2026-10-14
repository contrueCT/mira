---
name: "transcribe"
description: "Transcribe audio files to text with optional diarization and known-speaker hints. Use when a user asks to transcribe speech from audio/video, extract text from recordings, or label speakers in interviews or meetings."
---

> Mira adaptation: Read [runtime setup](../../docs/development/runtime-tools.md) before running commands. Resolve scripts and references relative to this SKILL.md; use ordinary read/bash. Install only missing task dependencies in a user-owned venv. Use a work/output directory outside the source checkout. Upstream system-install commands are examples, not permission for sudo or large downloads.
> Live transcription uploads audio to OpenAI and may incur charges. Confirm that the user has authorized this service/data transfer and cost before a live call. An installed SDK or existing key is not that authorization. Do not download a local model as an automatic fallback. Never display credentials.



# Audio Transcribe

Transcribe audio using OpenAI, with optional speaker diarization when requested. Prefer the bundled CLI for deterministic, repeatable runs.

## Workflow
1. Collect inputs: audio file path(s), desired response format (text/json/diarized_json), optional language hint, and any known speaker references.
2. Check only whether `OPENAI_API_KEY` is set, without printing its value. If missing, explain the live-call prerequisite and let the user choose whether to configure OpenAI access (do not ask them to paste the key).
3. Run the bundled `transcribe_diarize.py` CLI with sensible defaults (fast text transcription).
4. Validate the output: transcription quality, speaker labels, and segment boundaries; iterate with a single targeted change if needed.
5. Save outputs under `output/transcribe/` relative to the chosen work directory outside the source checkout.

## Decision rules
- Default to `gpt-4o-mini-transcribe` with `--response-format text` for fast transcription.
- If the user wants speaker labels or diarization, use `--model gpt-4o-transcribe-diarize --response-format diarized_json`.
- If audio is longer than ~30 seconds, keep `--chunking-strategy auto`.
- Prompting is not supported for `gpt-4o-transcribe-diarize`.

## Output conventions
- Use `output/transcribe/<job-id>/` for evaluation runs.
- Use `--out-dir` for multiple files to avoid overwriting.

## Dependencies (install if missing)
Set `MIRA_TOOLS_PYTHON` to the selected user-owned venv Python described in runtime setup. Prefer `uv` for dependency management; install only what this task needs.

```
uv pip install --python "$MIRA_TOOLS_PYTHON" openai
```
If `uv` is unavailable:
```
"$MIRA_TOOLS_PYTHON" -m pip install openai
```

## Environment
- `OPENAI_API_KEY` must be set for live API calls.
- If the key is missing, explain that live transcription is unavailable until the user chooses and configures OpenAI access. Do not create credentials, start login, or configure a key automatically.
- Never ask the user to paste the full key in chat.

## Skill path (set once)

```bash
# Set SKILL_DIR to the directory containing this loaded SKILL.md.
export TRANSCRIBE_CLI="$SKILL_DIR/scripts/transcribe_diarize.py"
```

Use the actual discovered skill path, whether from the source checkout or Mira home; do not assume a Codex installation.

## CLI quick start
Single file (fast text default):
```
"$MIRA_TOOLS_PYTHON" "$TRANSCRIBE_CLI" \
  path/to/audio.wav \
  --out transcript.txt
```

Diarization with known speakers (up to 4):
```
"$MIRA_TOOLS_PYTHON" "$TRANSCRIBE_CLI" \
  meeting.m4a \
  --model gpt-4o-transcribe-diarize \
  --known-speaker "Alice=refs/alice.wav" \
  --known-speaker "Bob=refs/bob.wav" \
  --response-format diarized_json \
  --out-dir output/transcribe/meeting
```

Plain text output (explicit):
```
"$MIRA_TOOLS_PYTHON" "$TRANSCRIBE_CLI" \
  interview.mp3 \
  --response-format text \
  --out interview.txt
```

## Local validation

The CLI supports `--dry-run` to validate inputs without the OpenAI SDK, API key, or network call. This does not transcribe audio. With `--known-speaker`, its dry-run payload includes reference audio as base64; do not expose real speaker-reference bytes in tool output. Use synthetic references for dry-run tests.

## Reference map
- `references/api.md`: supported formats, limits, response formats, and known-speaker notes.
