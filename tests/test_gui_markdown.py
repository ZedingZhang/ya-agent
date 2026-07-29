import unittest

from ya.gui_markdown import markdown_lines


def _plain(lines):
    return "\n".join("".join(span.text for span in line) for line in lines)


class GuiMarkdownTests(unittest.TestCase):
    def test_renders_common_markdown_with_tags(self):
        lines = markdown_lines("## Title\n**bold** *italic* `code` [site](https://example.com)\n- item\n> quote\n| Key | Value |\n| --- | --- |\n| Ya | Agent |")
        output = _plain(lines)
        self.assertIn("Title", output)
        self.assertIn("bold italic code site", output)
        self.assertIn("• item", output)
        self.assertIn("│ quote", output)
        self.assertIn("Key: Ya", output)
        self.assertNotIn("##", output)
        tags = {tag for line in lines for span in line for tag in span.tags}
        self.assertTrue({"heading", "bold", "italic", "code", "link"}.issubset(tags))

    def test_sanitizes_controls_and_recovers_unclosed_fence(self):
        lines = markdown_lines("```sql\nSELECT 1;\n## Recovered\n**safe**\x1b[31m")
        output = _plain(lines)
        self.assertIn("SELECT 1;", output)
        self.assertIn("Recovered", output)
        self.assertIn("safe", output)
        self.assertNotIn("\x1b", output)

    def test_unknown_syntax_is_preserved(self):
        self.assertEqual(_plain(markdown_lines("~~unfinished~~")), "~~unfinished~~")
