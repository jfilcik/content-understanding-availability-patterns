"""Stage only the offline teaching guides for GitHub Pages."""

import argparse
from html import escape
from pathlib import Path
import re
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
GUIDES = ("README.html", "single-apim-failover.html")


def build_site(source: Path, destination: Path, repository: str, ref: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Use a GitHub repository in owner/name form.")
    if not ref or any(ord(character) < 32 for character in ref):
        raise ValueError("Use a nonempty source branch or commit reference.")
    allowed_files = {*GUIDES, "index.html", ".nojekyll"}
    if destination.exists() and (
        not destination.is_dir()
        or any(path.name not in allowed_files or not path.is_file() or path.is_symlink()
               for path in destination.iterdir())
    ):
        raise ValueError("The site output directory must be empty or contain only previously staged guide files.")
    documents = {name: (source / name).read_text(encoding="utf-8") for name in GUIDES}
    source_url = f"https://github.com/{repository}/blob/{quote(ref, safe='')}/"

    def source_link(match: re.Match) -> str:
        path, fragment = match.group(1), match.group(2) or ""
        return f'href="{escape(source_url + path + fragment, quote=True)}"'

    destination.mkdir(parents=True, exist_ok=True)
    for name, content in documents.items():
        content = re.sub(r'href="((?:test-app/)?README\.md)(#[^"]*)?"', source_link, content)
        (destination / name).write_text(content, encoding="utf-8")
    (destination / "index.html").write_text(
        (destination / "README.html").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (destination / ".nojekyll").touch()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, help="GitHub owner/name for source documentation links.")
    parser.add_argument("--ref", default="main", help="Source branch or commit for documentation links.")
    parser.add_argument("--output", type=Path, default=ROOT / "_site")
    args = parser.parse_args()
    try:
        build_site(ROOT, args.output.resolve(), args.repository, args.ref)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Site build failed: {error}\n")
    print(f"Offline guides staged in {args.output}. No live lab or local configuration was included.")


if __name__ == "__main__":
    main()
