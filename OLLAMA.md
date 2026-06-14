# Ollama Support in ClaudePrism

ClaudePrism can use locally-hosted [Ollama](https://ollama.com/) models as an alternative to the Claude Code backend. This lets you chat about your LaTeX project and receive structured edit suggestions while keeping everything on your machine.

## What works

- **Streaming chat** with any Ollama model.
- **Structured file edits**: Ollama can emit `<proposed-change>` blocks that ClaudePrism converts into proposed changes, just like Claude's Write/Edit tools.
- **Per-tab provider switching**: each conversation can independently use Claude or Ollama, or you can change the provider on the fly from the composer.

## What does not work (yet)

- Native Claude Code tool use (`Bash`, `Read`, `Write`, etc.) is **not available** through Ollama.
- Persistent sessions are **not** stored for Ollama; each prompt sends the current conversation history.
- Claude-specific slash commands and skills rely on the Claude Code CLI and are only available with the Claude provider.

## Setup

1. [Install Ollama](https://ollama.com/download) and start it locally.
2. Pull a model:
   ```bash
   ollama pull llama3
   ```
3. Open ClaudePrism and switch the chat provider to **Ollama** from the composer model picker.
4. Confirm the Ollama URL (default: `http://localhost:11434`) and click **Refresh** to load your local models.
5. Select a model and start chatting.

## Structured edits

When you ask Ollama to modify a file, it can output edits in this format:

```xml
<proposed-change file="relative/path.tex">
<old>
exact existing text
</old>
<new>
replacement text
</new>
</proposed-change>
```

ClaudePrism parses these blocks after the response finishes and shows them in the **Proposed Changes** panel. You can accept or reject each change, just like edits from Claude.

## Troubleshooting

- **"Could not connect to Ollama"** — make sure the Ollama server is running and reachable at the configured URL.
- **"No models found"** — pull at least one model with `ollama pull <model>`.
- **Edits not applied** — the old text in the `<old>` block must closely match the file. The parser tolerates leading/trailing blank lines; for larger mismatches, try rephrasing your request or making the change manually.
