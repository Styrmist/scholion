# Third-party licenses

This plugin bundles the following third-party software into `main.js` at build time. Their licenses apply to the bundled portions and are listed below alongside their upstream sources.

## openpgp.js

- **Used for:** verifying the detached PGP signature on Anthropic's release manifest before installing the bundled `claude` binary. See [src/binary/verify.ts](src/binary/verify.ts).
- **License:** [GNU Lesser General Public License v3.0 or later (LGPL-3.0+)](https://www.gnu.org/licenses/lgpl-3.0.html)
- **Upstream:** <https://github.com/openpgpjs/openpgpjs>
- **Notice:** The plugin source is published in this repository, and `npm install && npm run build` reproduces `main.js` deterministically. Anyone wishing to replace the bundled openpgp.js with a modified version may do so by editing `package.json`, running `npm install`, and rebuilding.

## obsidian (type definitions only)

- **Used for:** TypeScript types and runtime API surface inside Obsidian. Not bundled into `main.js` — Obsidian provides the runtime.
- **License:** [Obsidian developer license](https://github.com/obsidianmd/obsidian-api/blob/master/LICENSE.txt) (MIT-style; bundled types only).
- **Upstream:** <https://github.com/obsidianmd/obsidian-api>

---

The plugin's own source code is licensed under [BSD 2-Clause](LICENSE). Build-time-only dev dependencies (esbuild, eslint, typescript, etc.) are not bundled and their licenses do not apply to distributed artifacts.
