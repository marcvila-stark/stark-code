The app ships this pinned, offline Stark Workbench plugin and its production dependencies.
`provenance.json` records the source commit, lockfile hash, payload hash, and desktop adaptations.
Loading the plugin needs no sibling checkout, npm install, or global Node installation at runtime.
Stark Pages services still use the user's existing Claude connection and credentials.

Desktop build/dev/start extracts the integrity-checked archive into `apps/desktop/resources/stark-workbench`.
Packaging puts that tree at `resources/stark-workbench`, outside ASAR so native Claude can read it.
The desktop forwards its validated absolute path as `STARK_WORKBENCH_ROOT` and its executable as
`STARK_WORKBENCH_NODE`. Hooks use that executable in Node mode even with a short Dock PATH.
The app owns mirror lifetime; plugin hooks keep their validation and publishing checks.

To refresh after reviewing a source commit, run with Node/npm and Python 3 installed:

```sh
python3 scripts/vendor-stark-workbench.py /path/to/stark-workbench <full-commit>
node scripts/prepare-stark-workbench.mjs
```

The update command reads only tracked runtime files at that commit, installs exactly its lockfile
with lifecycle scripts disabled, materializes package links, and normalizes archive ordering and metadata.
Do not copy an existing development node_modules tree or include credentials, user state, or Git metadata.
Chat-mode publishing remains disabled until plugin guard approvals have been verified live in the SDK.
