#!/usr/bin/env python3
"""Refresh the offline Workbench payload from an explicit, reviewed Git commit.

Requires Python 3, git, and npm. Only this maintenance command uses npm/network;
desktop builds and launches extract the checked-in, integrity-pinned archive.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile


def run(*args, **kwargs):
    return subprocess.check_output(args, **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("commit")
    args = parser.parse_args()
    destination = Path(__file__).resolve().parent.parent / "vendor/stark-workbench"
    commit = run("git", "-C", str(args.source), "rev-parse", args.commit).decode().strip()
    tracked = run("git", "-C", str(args.source), "ls-tree", "-r", "--name-only", commit).decode().splitlines()
    selected = [name for name in tracked if (
        name in ("package.json", "package-lock.json") or
        name.startswith((".claude-plugin/", "hooks/", "skills/", "commands/", "examples/")) or
        (name.startswith("packages/") and ("/src/" in name or "/bin/" in name or name.endswith("/package.json")))
    )]
    with tempfile.TemporaryDirectory(prefix="stark-workbench-vendor-") as scratch:
        root = Path(scratch)
        for name in selected:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(run("git", "-C", str(args.source), "show", f"{commit}:{name}"))
        lock_hash = hashlib.sha256((root / "package-lock.json").read_bytes()).hexdigest()
        subprocess.run(["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", str(root / ".npm-cache")], cwd=root, check=True)

        # Claude runs hooks in its shell. Use the app's absolute Electron/Node
        # executable; an app opened from the Dock need not have node on PATH.
        prefix = 'ELECTRON_RUN_AS_NODE=1 "${STARK_WORKBENCH_NODE:-node}" '
        hooks_path = root / "hooks/hooks.json"
        hooks = json.loads(hooks_path.read_text())
        for groups in hooks["hooks"].values():
            for group in groups:
                for hook in group["hooks"]:
                    assert hook["command"].startswith("node ")
                    hook["command"] = prefix + hook["command"][5:]
        hooks_path.write_text(json.dumps(hooks, indent=2) + "\n")
        for folder in ("skills", "commands"):
            for file in (root / folder).rglob("*.md"):
                file.write_text(file.read_text().replace('node "', prefix + '"'))
        server_path = root / "packages/spage/src/server.js"
        text = server_path.read_text()
        marker = "export function spawnDetachedMirror(root, opts = {}) {"
        assert text.count(marker) == 1
        server_path.write_text(text.replace(marker, marker + '\n  if (process.env.STARK_WORKBENCH_MANAGED_MIRROR === "1") return false;'))

        files = []
        for base, dirs, names in os.walk(root, followlinks=True):
            dirs[:] = sorted(d for d in dirs if d not in (".bin", ".git", ".npm-cache", "test", "tests", "__tests__", "fixtures", "coverage"))
            for name in sorted(names):
                relative = (Path(base) / name).relative_to(root).as_posix()
                if name.startswith(".env") or name.endswith((".map", ".tsbuildinfo")) or name == ".package-lock.json":
                    continue
                files.append(relative)
        # Materialize workspace links as ordinary files so the payload never
        # references the source checkout, npm cache, or another installation.
        payload = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=payload, mtime=0, compresslevel=9) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for relative in sorted(files):
                    data = (root / relative).read_bytes()
                    info = tarfile.TarInfo(relative)
                    info.size, info.mode, info.mtime = len(data), 0o644, 0
                    archive.addfile(info, io.BytesIO(data))
        destination.mkdir(parents=True, exist_ok=True)
        content = payload.getvalue()
        (destination / "runtime.tar.gz").write_bytes(content)
        provenance = {
            "repository": "stark-workbench",
            "commit": commit,
            "packageLockSha256": lock_hash,
            "archiveSha256": hashlib.sha256(content).hexdigest(),
            "files": len(files),
            "adaptations": [
                "Hooks and command/skill examples use STARK_WORKBENCH_NODE with ELECTRON_RUN_AS_NODE=1.",
                "STARK_WORKBENCH_MANAGED_MIRROR=1 delegates mirror lifecycle to the desktop app.",
                "Production dependencies included, workspace symlinks materialized; tests, fixtures, source maps, caches excluded.",
            ],
        }
        (destination / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
        print(f"Bundled {len(files)} files, {len(content)} bytes, sha256 {provenance['archiveSha256']}")


if __name__ == "__main__":
    main()
