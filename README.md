# Scholion

Run [Claude Code](https://claude.com/claude-code) in an Obsidian sidebar. Chat with Claude, let it read and edit notes via the standard tool set, and keep one persistent session per chat — all using your existing Claude.ai subscription (or any auth the bundled Claude Code CLI accepts).

Desktop-only. Bundles its own copy of the official Claude Code binary to not violate Anthropic ToS about claude.ai subscription usage; nothing else needs to be installed on the system.

## Features
- **Currently tested on macOS only.** Support for other platforms will be added soon.
- **Sidebar chat view**, multi-session, with persistent transcripts saved per session.
- **Streaming markdown rendering** with chunk-and-commit so long responses stay snappy.
- **Tool cards** for `Read`, `Grep`, `Edit`, `Write`, `Bash`, `WebFetch`, etc. Click the header to expand the body and see input + output preview; "View full output" opens larger results in a modal.
- **Inline permission prompts** — when Claude wants to use a tool that's not on the allow-list, you get four buttons in the chat: *Allow once*, *Allow this session*, *Allow always*, *Deny*.
- **Active-note context attachment**: the current note (or selection) is auto-attached to your turn. Click the chip in the composer to detach.
- **Session picker** with fuzzy search, last-modified hints, and a one-line summary of the previous reply.
- **Per-session running cost & token counters** in the status pill.
- **Diagnostics panel** below the transcript that captures stderr lines and `api_retry` events, persisted with the session.
- **Model selection** in settings: `sonnet` (default), `opus`, `haiku`, `opusplan`, or any custom model ID / inference profile / deployment name.
- **Configurable send shortcut**: `Enter` (default) or `⌘↵` / `Ctrl+Enter`.

## Security

Treats the bundled CLI as an untrusted child process. Specifically:

- **Verified install.** Each release manifest is signed with Anthropic's PGP key (fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`). The plugin embeds the public key and verifies the signature before trusting the manifest's SHA256, then verifies the binary against that SHA256. Fail-closed: any signature problem aborts the install.
- **Isolated environment.** Spawned with a pruned env that strips anything that could redirect auth or routing — `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*_AUTH`, `AWS_*`, `AZURE_*`, `GOOGLE_*`, etc. (See [src/cli/env.ts](src/cli/env.ts) for the full list.) `CLAUDE_CONFIG_DIR` is forced to a per-vault directory inside the plugin folder.
- **Always-on deny rules.** The plugin's own config dir (where credentials live) is added to the CLI's deny list for `Read`, `Edit`, `Write`, and `Bash` tool patterns, with glob meta characters in the path properly escaped.

## Requirements

- Obsidian 1.5+ on macOS, Linux, or Windows (no mobile).
- A Claude.ai subscription, an Anthropic API account, or a configured cloud provider (Bedrock / Vertex / Foundry). The bundled CLI handles whichever you have.
- Network access to `downloads.claude.ai` to install the binary, and to your chosen Anthropic endpoint at runtime.

## Installation

> Not yet listed in the Obsidian Community Plugins catalog. Install manually for now.

1. Download `scholion-<version>.zip` from the [latest GitHub release](https://github.com/Styrmist/obsidian-claude-code/releases/latest), or build it yourself (see Development below).
2. Extract it directly into `<your-vault>/.obsidian/plugins/`. The archive contains a top-level `scholion/` folder, so you'll end up with `<your-vault>/.obsidian/plugins/scholion/{main.js,manifest.json,styles.css}`.
3. In Obsidian: **Settings → Community plugins** → enable **Scholion**.
4. Open the new ribbon icon (or the command palette → "Scholion") to reveal the chat view.
5. **Settings → Scholion → Binary → Install latest** to download the bundled CLI.
6. **Settings → Scholion → Account → Sign in** to authenticate via the standard browser-OAuth flow.

## Configuration

All settings live under **Settings → Scholion**. Highlights:

- **Permissions → Always-allowed tools / Always-denied tools** — pre-grant or block specific tools globally. Read/Grep/Glob are allowed by default; Edit/Write/Bash require explicit grant or per-session approval.
- **Model & prompt → Model** — pick from the dropdown, or **Custom…** for a full model name (`claude-opus-4-7`), an inference profile ARN (Bedrock), or a deployment name (Foundry).
- **Composer → Send shortcut** — `Enter` (default) or `⌘↵` / `Ctrl+Enter`.
- **Context → Auto-attach active note** — toggle whether the open note is bundled into each turn.
- **Advanced → Verbose logging** — print stream events and diagnostics to the developer console.
- **Advanced → Reset plugin data** — wipe binary, sessions, and credentials.

## Sessions and persistence

- One session per chat. Sessions are saved as JSON under `<vault>/.obsidian/plugins/scholion/sessions/<localId>.json`.
- Empty new chats are not persisted — switching away discards them. The session is registered in the picker on the first user message.
- Per-session permissions, diagnostics, and running usage totals all persist across reloads.
- Reload-mid-turn is safe: the spawned `claude` child receives `SIGINT`, then `SIGKILL` after a grace period; no zombies.

## Development

```bash
git clone <this-repo>
cd obsidian-claude-code
npm install
npm run build      # tsc + esbuild production bundle → main.js
npm run dev        # watch mode
npm run lint       # eslint
```

For local development, symlink the repo into your vault's plugins directory:

```bash
ln -s "$PWD" "<vault>/.obsidian/plugins/scholion"
```

Obsidian loads the plugin via `manifest.id` (`scholion`), so the symlink directory name doesn't have to match.

The repository follows the conventions in [AGENTS.md](AGENTS.md). Roadmap and known issues live in [TODO.md](TODO.md).

## License

BSD 2-Clause — see [LICENSE](LICENSE).

The bundled `main.js` includes [openpgp.js](https://github.com/openpgpjs/openpgpjs) (LGPL-3.0+) for release-signature verification. See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for the full notice and rebuild instructions.
