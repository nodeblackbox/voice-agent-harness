# Contributing

Issues and pull requests are welcome.

- Read [AGENTS.md](AGENTS.md) for the map and the conventions, and [docs/EXTENDING.md](docs/EXTENDING.md) for the
  recipes (a provider, a voice, a tool, an MCP server, a tuning parameter). They are written for people and for
  coding agents alike.
- `pnpm check` (typecheck + tests) and `pnpm test:py` must pass. Tests sit next to the code they cover.
- No personal defaults: paths come from Electron or settings, devices from the system default, nothing in the tree
  names a drive, a user or a product.
- Never commit `.env`, `proxies.txt` or anything from `%APPDATA%\Voice Agent`, and never paste live keys into
  issues or logs. The session traces under `logs/sessions` contain what you said; strip them before sharing.
- One commit per change, with a message that says why.
