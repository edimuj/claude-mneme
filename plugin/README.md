<p align="center">
  <img src="https://raw.githubusercontent.com/edimuj/claude-mneme/main/assets/claude-mneme-mascot-128.png" alt="Claude Mneme Mascot" width="128">
</p>

# Claude Mneme — Plugin

Persistent memory for Claude Code. Automatically captures your coding sessions and injects relevant context into new ones so Claude picks up where you left off.

## Quick Start

```bash
# Install from npm
claude plugin add --from npm:claude-mneme

# Or from marketplace
claude plugin marketplace add edimuj/claude-mneme
claude plugin install claude-mneme

# Or directly from GitHub
claude plugin add --from https://github.com/edimuj/claude-mneme/tree/main/plugin
```

## What It Does

- Captures prompts, tasks, commits, and responses automatically
- Summarizes old entries with Haiku when the log grows
- Injects relevant context at session start (decisions, state, recent work)
- Tracks files, functions, and errors for smarter context selection
- Optional sync server for multi-machine memory

## Commands

| Command | Description |
|---------|-------------|
| `/remember` | Save something to memory |
| `/forget` | Remove remembered items |
| `/summarize` | Force immediate summarization |
| `/status` | Health check and diagnostics |
| `/entity` | Look up what Mneme knows about a file or function |

## Full Documentation

See the [main README](https://github.com/edimuj/claude-mneme#readme) for installation options, configuration, architecture details, and sync server setup.
