"""Package source and the verified static build without development dependencies."""
import argparse
import hashlib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

parser = argparse.ArgumentParser()
parser.add_argument("destination", type=Path)
destination = parser.parse_args().destination.resolve()
root = Path(__file__).resolve().parents[1]
if not (root / "dist" / "index.html").is_file():
    raise SystemExit("Run npm run build before packaging.")
included = (
    ".github", ".gitignore", "CONTRIBUTING.md", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md",
    "index.html", "netlify.toml", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts",
    "dist", "docs", "public", "qa", "scripts", "src",
)
destination.parent.mkdir(parents=True, exist_ok=True)
temporary = destination.with_name("." + destination.name + ".incomplete")
with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
    for name in included:
        path = root / name
        files = sorted(path.rglob("*")) if path.is_dir() else [path]
        for file in files:
            if not file.is_file() or file.is_symlink():
                continue
            archive.write(file, "StickerWave/" + file.relative_to(root).as_posix())

with ZipFile(temporary) as archive:
    corrupt = archive.testzip()
    if corrupt:
        raise SystemExit(f"Invalid archive entry: {corrupt}")
temporary.replace(destination)
with destination.open("rb") as file:
    digest = hashlib.file_digest(file, "sha256").hexdigest()
print(f"{destination.name}: {destination.stat().st_size} bytes, SHA-256 {digest}")
