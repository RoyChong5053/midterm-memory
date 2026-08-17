# Mid-Term Memory

A SillyTavern third-party extension that periodically summarizes recent chat history into a structured memory log, using a **timeline-based raw prompt** (`**Speaker** [YYYY-MM-DD HH:mm]: text`) so the summarizer sees the conversation in chronological order.

Built on the official built-in Summarize (memory) extension, adapted as a standalone plugin with:

- **Timeline raw prompt** — every message fed to the summarizer is formatted with bold speaker + timestamp.
- **Two summarization sources**:
  - `Main API` — uses SillyTavern's configured main API.
  - `OpenAI-compatible (local)` — point it at any OpenAI-compatible endpoint (e.g. local `llama.cpp` server), by entering the IP + port directly.
- **Configurable context size** for the local OpenAI source (defaults to ST's max context when `0`).
- **Run / Pause** checkbox (checked = running).
- **Process length** — controls the target output length of each summary via the `{{words}}` macro (no 1000-word cap).
- Raw prompt **preview** button to inspect exactly what gets sent to the summarizer.
- `{{summary}}` macro and `/summarize` slash command.

## Install

Place the folder in `SillyTavern/public/scripts/extensions/third-party/`, then enable it in the Extensions menu.

Or install directly from GitHub via ST's third-party extension installer:

```
https://github.com/RoyChong5053/midterm-memory
```

## Usage

1. Open **Extensions → Mid-Term Memory**.
2. Choose a summarization source:
   - **Main API**: uses ST's configured API.
   - **OpenAI-compatible (local)**: fill in `API Base URL` (e.g. `http://127.0.0.1:8080`), optional API key and model.
3. The default **Summary Prompt** is a User State Tracker that maintains a structured state log (sleep/wake, intake, energy/mood, activity, health, other). Edit it to fit your use case.
4. Set **Process length**, **Update frequency** (messages / words), and the **injection position**.
5. Keep **Run** checked to auto-update. Use **Summarize now** to force an update, or **Preview raw prompt** to inspect the extracted context.

## How the raw prompt is built

- The last message is excluded (so in-progress content is never summarized).
- Messages after the most recent summary are collected, newest-excluded.
- Each entry is formatted as a timeline line, and the previous summary is prepended.
- Collection stops when the token budget is exceeded or the max messages per request is reached.

## Notes

- Summaries are stored on the chat message `extra.memory`, same as the built-in extension — so existing chats work.
- If you previously used the official Summarize extension, disable it to avoid duplicate `{{summary}}` / `/summarize` registrations.