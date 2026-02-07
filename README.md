# feishu-doc-comment

An [OpenClaw](https://github.com/nicholasxuu/openclaw) plugin that monitors Feishu (飞书/Lark) document comments and automatically replies using AI.

## Features

- **Index Document Pattern**: Configure a single "index document" containing links to other documents. The plugin automatically discovers and monitors all linked documents.
- **Periodic Polling**: Polls for new comments at configurable intervals (default: 15 minutes).
- **AI-Powered Replies**: Uses OpenClaw's AI agent to generate contextual replies to document comments, with the document content as context.
- **State Persistence**: Tracks processed comments to avoid duplicate replies across restarts.

## Architecture

```
Index Document (飞书 wiki page)
├── Link to Doc A  ──→  Poll comments on Doc A
├── Link to Doc B  ──→  Poll comments on Doc B
└── Link to Doc C  ──→  Poll comments on Doc C
                          ↓
                    New comment detected
                          ↓
                    AI generates reply
                          ↓
                    Reply posted to thread
```

## Prerequisites

- An [OpenClaw](https://github.com/nicholasxuu/openclaw) instance with Feishu channel configured
- A Feishu app with the following permissions:
  - `docx:document:readonly` — Read document content
  - `drive:drive:comment` — Read and write comments

## Installation

1. Copy this directory to `~/.openclaw/extensions/feishu-doc-comment/`
2. Install dependencies:
   ```bash
   cd ~/.openclaw/extensions/feishu-doc-comment
   npm install
   ```
3. Create `config.json` (see `config.example.json`):
   ```json
   {
     "pollIntervalMinutes": 15,
     "indexDocument": "YOUR_INDEX_DOCUMENT_TOKEN"
   }
   ```
4. Enable the plugin in `~/.openclaw/openclaw.json`:
   ```json
   {
     "plugins": {
       "entries": {
         "feishu-doc-comment": {
           "enabled": true
         }
       }
     }
   }
   ```
5. Restart OpenClaw

## Configuration

### `config.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pollIntervalMinutes` | number | 15 | How often to poll for new comments (in minutes) |
| `indexDocument` | string | — | Token of the index document containing links to monitored docs |
| `watchedFiles` | string[] | [] | Direct list of document tokens to monitor (alternative to indexDocument) |

### Getting a Document Token

From a Feishu document URL like:
```
https://xxx.feishu.cn/docx/IgsgdibZJoWxh4xIuvBcT46InAe
```
The token is: `IgsgdibZJoWxh4xIuvBcT46InAe`

## How It Works

1. On startup (and at each polling interval), the plugin reads the index document
2. It extracts all Feishu document links from bullet points, headings, and text blocks
3. For each linked document, it fetches all comments
4. New (unprocessed) comments trigger an AI response using OpenClaw's agent
5. The AI reply is posted as a threaded reply to the original comment
6. Processed comment IDs are saved to `state.json` to avoid duplicates

## License

MIT
