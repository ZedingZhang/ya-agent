import os
import unittest
from unittest.mock import patch

from ya.terminal import StreamingMarkdownRenderer, format_output, render_markdown, strip_terminal_controls


class TerminalRendererTests(unittest.TestCase):
    def test_renders_common_markdown_without_markers(self):
        text = """## Title

**bold** and *italic* with `code`

- item
1. first
> quote

| Name | Value |
| --- | --- |
| Ya | Agent |

---
"""
        rendered = render_markdown(text)
        self.assertIn("Title", rendered)
        self.assertIn("bold and italic with code", rendered)
        self.assertIn("- item", rendered)
        self.assertIn("- first", rendered)
        self.assertIn("| quote", rendered)
        self.assertIn("Name: Ya; Value: Agent", rendered)
        self.assertNotIn("##", rendered)
        self.assertNotIn("**", rendered)
        self.assertNotIn("| ---", rendered)

    def test_preserves_unknown_markdown(self):
        self.assertEqual(render_markdown("~~unfinished~~"), "~~unfinished~~")

    def test_sanitizes_terminal_controls(self):
        self.assertEqual(strip_terminal_controls("safe\x1b[31m text\x07\r"), "safe text")

    def test_auto_uses_raw_markdown_when_not_a_tty(self):
        self.assertEqual(format_output("## Title", "auto", is_tty=False), "## Title")

    def test_terminal_format_renders_without_color_when_requested_for_pipe(self):
        self.assertEqual(format_output("## Title", "terminal", is_tty=False), "Title")

    def test_no_color_disables_ansi_sequences(self):
        with patch.dict(os.environ, {"NO_COLOR": ""}, clear=True):
            rendered = format_output("## Title", "terminal", is_tty=True)
        self.assertEqual(rendered, "Title")

    def test_streaming_renderer_handles_split_markdown_lines_and_tables(self):
        renderer = StreamingMarkdownRenderer()
        rendered = renderer.write("## Ti") + renderer.write("tle\n\n| Name | Value |\n| --- | --- |\n| Ya | Agent |\n") + renderer.finish()
        self.assertIn("Title", rendered)
        self.assertIn("Name: Ya; Value: Agent", rendered)
        self.assertNotIn("##", rendered)

    def test_recovers_from_an_unclosed_code_fence_at_a_heading(self):
        text = """## Start
```sql
SELECT 1;
   ## Recovered heading
- **bold item**
"""

        buffered = render_markdown(text)
        renderer = StreamingMarkdownRenderer()
        streamed = renderer.write(text) + renderer.finish()

        for rendered in (buffered, streamed):
            self.assertIn("SELECT 1;", rendered)
            self.assertIn("Recovered heading", rendered)
            self.assertIn("- bold item", rendered)
            self.assertNotIn("## Recovered", rendered)
            self.assertNotIn("**bold item**", rendered)
