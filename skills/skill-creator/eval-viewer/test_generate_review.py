import contextlib
import io
import json
import socket
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import patch

import generate_review


class EmbeddedDataTests(unittest.TestCase):
    def test_nested_data_survives_the_html_script_boundary(self):
        class Scripts(HTMLParser):
            def __init__(self):
                super().__init__()
                self.inline = []
                self.current = False

            def handle_starttag(self, tag, attrs):
                if tag == "script":
                    self.current = not any(name == "src" for name, _ in attrs)
                    if self.current:
                        self.inline.append("")

            def handle_data(self, data):
                if self.current:
                    self.inline[-1] += data

            def handle_endtag(self, tag):
                if tag == "script":
                    self.current = False

        for text in (
            '</script><i data-injection="yes">synthetic</i><script>',
            '</ScRiPt ><i data-injection="yes">synthetic</i><script>',
            '<!--<script>synthetic</script>',
            json.loads(r'"\u003c/script>synthetic"'),
            'Literal &lt; &#34; & " \' Unicode \u2028\u2029',
        ):
            with self.subTest(text=text):
                run = {"id": "run-1", "prompt": text, "outputs": [
                    {"name": "output.txt", "type": "text", "content": text}],
                    "grading": {"summary": {"passed": text}}}
                previous = {"run-1": {"feedback": text, "outputs": run["outputs"]}}
                benchmark = {"metadata": {"timestamp": text}}
                page = generate_review.generate_html([run], text, previous, benchmark)
                parser = Scripts()
                parser.feed(page)
                self.assertEqual(len(parser.inline), 1)
                encoded = parser.inline[0].split("const EMBEDDED_DATA = ", 1)[1].split(";\n", 1)[0]
                self.assertNotIn("<", encoded)
                self.assertEqual(json.loads(encoded), {
                    "skill_name": text, "runs": [run],
                    "previous_feedback": {"run-1": text},
                    "previous_outputs": {"run-1": run["outputs"]},
                    "benchmark": benchmark,
                })


class ReviewServerTests(unittest.TestCase):
    def test_occupied_port_preserves_listener_and_uses_free_port(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as listener:
            (Path(directory) / "outputs").mkdir()
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            opened = []
            argv = ["generate_review.py", directory, "--port", str(port)]

            def check_viewer(url):
                opened.append(url)
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    connection, _ = listener.accept()
                    connection.close()

            with (
                patch.object(sys, "argv", argv),
                patch("os.kill", side_effect=AssertionError("must not signal processes")),
                patch("subprocess.run", side_effect=AssertionError("must not inspect processes")),
                patch.object(generate_review.webbrowser, "open", side_effect=check_viewer),
                patch.object(generate_review.HTTPServer, "serve_forever", side_effect=KeyboardInterrupt),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                generate_review.main()

            self.assertEqual(len(opened), 1)
            self.assertNotEqual(opened[0], f"http://localhost:{port}")


if __name__ == "__main__":
    unittest.main()
