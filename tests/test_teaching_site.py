from html.parser import HTMLParser
from pathlib import Path
import re
import tempfile
import unittest
from urllib.parse import urlsplit

from scripts.build_site import ROOT, build_site


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.ids = set()

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if "id" in values:
            self.ids.add(values["id"])
        if tag == "a" and "href" in values:
            self.links.append(values["href"])


class TeachingSiteTests(unittest.TestCase):
    def test_readme_and_guide_local_links_and_markdown_anchors_resolve(self):
        for name in ("README.md", "test-app/README.md", "README.html", "single-apim-failover.html"):
            source = ROOT / name
            content = source.read_text(encoding="utf-8")
            if source.suffix == ".html":
                parsed = Links()
                parsed.feed(content)
                links = parsed.links
            else:
                links = re.findall(r"\[[^\]]+\]\(([^)\s]+)\)", content)
            for link in links:
                url = urlsplit(link)
                if url.scheme or url.netloc:
                    continue
                target = source.parent / url.path if url.path else source
                self.assertTrue(target.is_file(), (name, link))
                if url.fragment and target.suffix == ".md":
                    headings = re.findall(r"^#{1,6}\s+(.+)$", target.read_text(encoding="utf-8"), re.MULTILINE)
                    anchors = {re.sub(r"[^\w -]", "", heading.lower()).replace(" ", "-") for heading in headings}
                    self.assertIn(url.fragment, anchors, (name, link))

    def test_site_allowlist_excludes_live_app_configuration_and_unrelated_files(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "site"
            build_site(ROOT, output, "example/availability-patterns", "main")
            self.assertEqual(
                {".nojekyll", "index.html", "README.html", "single-apim-failover.html"},
                {path.name for path in output.iterdir()},
            )
            self.assertEqual(
                (output / "index.html").read_text(encoding="utf-8"),
                (output / "README.html").read_text(encoding="utf-8"),
            )
            build_site(ROOT, output, "example/availability-patterns", "main")
            for name in ("index.html", "README.html", "single-apim-failover.html"):
                content = (output / name).read_text(encoding="utf-8")
                self.assertIn("connect-src 'none'", content)
                self.assertIn('id="work-in-progress"', content)
                self.assertIn("Work in progress (WIP).", content)
                self.assertLess(content.index('id="work-in-progress"'), content.index('class="intro"'))
                header = content.split("<header", 1)[1].split("</header>", 1)[0]
                self.assertIn('aria-label="Guide navigation"', header)
                self.assertIn('href="https://github.com/jfilcik/content-understanding-availability-patterns"', header)
                self.assertIn('href="README.html"', header)
                self.assertIn('href="single-apim-failover.html"', header)
                self.assertIn('aria-hidden="true"', header)
                self.assertEqual(1, header.count('aria-current="page"'))
                self.assertNotIn('href="README.md', content)
                self.assertIn("https://github.com/example/availability-patterns/blob/main/README.md", content)
                self.assertNotIn('src="http', content)
                parsed = Links()
                parsed.feed(content)
                for link in parsed.links:
                    url = urlsplit(link)
                    if url.scheme or url.netloc:
                        continue
                    target = output / url.path if url.path else output / name
                    self.assertTrue(target.is_file(), (name, link))
                    if url.fragment:
                        target_html = Links()
                        target_html.feed(target.read_text(encoding="utf-8"))
                        self.assertIn(url.fragment, target_html.ids, (name, link))

    def test_source_links_include_ref_and_keep_anchors(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "source", Path(folder) / "site"
            source.mkdir()
            for name in ("README.html", "single-apim-failover.html"):
                (source / name).write_text(
                    '<a href="README.md#deploy">Deploy</a><a href="test-app/README.md#start">Lab</a>',
                    encoding="utf-8",
                )
            build_site(source, output, "example/repository", "guide/review")
            content = (output / "index.html").read_text(encoding="utf-8")
            self.assertIn("blob/guide%2Freview/README.md#deploy", content)
            self.assertIn("blob/guide%2Freview/test-app/README.md#start", content)

    def test_readme_guide_links_open_the_hosted_pages_instead_of_html_source(self):
        site = "https://jfilcik.github.io/content-understanding-availability-patterns/"
        for name in ("README.md", "test-app/README.md"):
            content = (ROOT / name).read_text(encoding="utf-8")
            links = re.findall(r"\[[^\]]+\]\(([^)\s]+)\)", content)
            self.assertIn(site, links, name)
            self.assertIn(site + "single-apim-failover.html", links, name)
            self.assertFalse(any(link.endswith(".html") and not urlsplit(link).scheme for link in links), name)

    def test_build_refuses_stale_output_instead_of_publishing_extra_files(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "site"
            output.mkdir()
            sentinel = output / "local-state.json"
            sentinel.write_text("do not publish", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "must be empty"):
                build_site(ROOT, output, "example/repository", "main")
            self.assertEqual("do not publish", sentinel.read_text(encoding="utf-8"))

    def test_repository_and_ref_are_validated_before_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "site"
            for repository, ref in (("invalid", "main"), ("a/b/c", "main"), ("owner/repo", ""), ("owner/repo", "main\n")):
                with self.subTest(repository=repository, ref=ref), self.assertRaises(ValueError):
                    build_site(ROOT, output, repository, ref)
            self.assertFalse(output.exists())

    def test_pages_is_opt_in_main_only_and_publishes_only_staged_guides(self):
        workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn("vars.PUBLISH_TEACHING_GUIDES == 'true'", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertNotIn("pull_request", workflow)
        self.assertIn("path: _site", workflow)
        self.assertNotIn("path: .\n", workflow)
        self.assertNotIn("enablement:", workflow)


if __name__ == "__main__":
    unittest.main()
