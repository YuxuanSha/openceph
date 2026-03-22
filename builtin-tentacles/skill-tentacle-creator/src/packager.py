from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED


def package_tentacle(target: Path) -> Path:
    archive = target.with_suffix(".tentacle")
    with ZipFile(archive, "w", ZIP_DEFLATED) as zf:
        for path in target.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(target))
    return archive
