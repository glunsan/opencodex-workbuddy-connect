"""Package allowlisted public source and the self-contained skill (Python stdlib only)."""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
ALLOWED = ["src", "tests", "scripts", "skills", ".github", ".gitignore", ".gitattributes", "README.md", "LICENSE", "NOTICE.md", "package.json", "Install.cmd", "Start-Bridge.cmd", "Uninstall.cmd", "Install-Skill.cmd"]
FORBIDDEN_NAMES = {"bridge.json", "runtime.json", "bridge-task.json", "config.json", "admin-api-token", "verification.json"}


def files_in(root):
    if root.is_symlink():
        raise ValueError(f"Symlink is not publishable: {root.name}")
    if root.is_file():
        yield root
    else:
        for file in sorted(root.rglob("*")):
            if file.is_symlink():
                raise ValueError(f"Symlink is not publishable: {file.name}")
            if file.is_file():
                yield file


def validate(file):
    name = file.name.lower()
    if name in FORBIDDEN_NAMES or name.endswith((".log", "-auth.json", ".pyc")) or name.startswith(".env"):
        raise ValueError(f"Private/generated file in release selection: {file.relative_to(ROOT)}")
    if any(part in {"node_modules", ".git", ".state", "__pycache__"} for part in file.relative_to(ROOT).parts):
        raise ValueError(f"Excluded directory in release selection: {file.relative_to(ROOT)}")


def archive(destination, root, files, top):
    expected = set()
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for file in files:
            validate(file)
            relative = file.relative_to(root).as_posix()
            arcname = f"{top}/{relative}"
            out.write(file, arcname)
            expected.add(arcname)
    with zipfile.ZipFile(destination) as result:
        if set(result.namelist()) != expected or result.testzip() is not None:
            raise ValueError("ZIP content verification failed")
        if not any(name.endswith("/SKILL.md") for name in result.namelist()):
            raise ValueError("Missing skill entrypoint")
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    options = parser.parse_args()
    target = options.output_dir.resolve()
    target.mkdir(parents=True, exist_ok=True)
    source_files = sorted(set(file for item in ALLOWED for file in files_in(ROOT / item)))
    skill = ROOT / "skills" / "workbuddy-connect"
    skill_files = list(files_in(skill))
    manifest = json.loads((skill / "assets/bridge/bundle-manifest.json").read_text(encoding="utf-8"))
    for relative, expected in manifest["files"].items():
        current = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
        snapshot = hashlib.sha256((skill / "assets/bridge" / relative).read_bytes()).hexdigest()
        if expected != current or expected != snapshot:
            raise ValueError(f"Stale skill runtime: {relative}; run npm run build:skill")
    hashes = []
    for filename, root, files, top in [
        (f"opencodex-workbuddy-connect-v{VERSION}.zip", ROOT, source_files, "opencodex-workbuddy-connect"),
        (f"workbuddy-connect-skill-v{VERSION}.zip", skill, skill_files, "workbuddy-connect"),
    ]:
        digest = archive(target / filename, root, files, top)
        hashes.append(f"{digest}  {filename}")
        print(f"{filename}: {len(files)} files; ZIP contents verified")
    (target / "SHA256SUMS.txt").write_text("\n".join(hashes) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
