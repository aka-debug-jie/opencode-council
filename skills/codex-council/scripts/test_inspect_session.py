#!/usr/bin/env python3
import json
import unittest
from pathlib import Path

from inspect_session import event_report, find_session, report, report_output, run_ready, state, validate_report


FIXTURES = json.loads(
    (Path(__file__).with_name("fixtures") / "session_states.json").read_text()
)


class InspectSessionTests(unittest.TestCase):
    def test_transient_and_wait_states(self):
        self.assertEqual(state(None), ("transient", ""))
        self.assertEqual(state(FIXTURES["empty"]), ("wait", ""))
        self.assertEqual(state(FIXTURES["running"]), ("wait", "msg-1"))

    def test_terminal_tool_calls_need_one_continuation(self):
        self.assertEqual(
            state(FIXTURES["completed_tool_calls"]),
            ("continue", "msg-1"),
        )
        self.assertEqual(
            state(FIXTURES["errored_tool_calls"]),
            ("continue", "msg-1"),
        )
        self.assertEqual(
            state(FIXTURES["completed_without_finish"]),
            ("wait", "msg-1"),
        )

    def test_stopped_report_is_validated(self):
        self.assertEqual(state(FIXTURES["stopped_report"]), ("stop", "msg-2"))
        self.assertIn("## Council Report", report(FIXTURES["stopped_report"]))
        with self.assertRaisesRegex(ValueError, "without a Council Report"):
            report(FIXTURES["stopped_without_report"])
        with self.assertRaisesRegex(ValueError, "latest assistant message"):
            report(FIXTURES["stopped_report"], "msg-old")

    def test_report_requires_exact_sections_and_normal_stop(self):
        valid = report(FIXTURES["stopped_report"])
        for invalid in (
            valid + "\n\n### Final recommendation\nDo it",
            valid.replace("### Risks\nD", "### Risks\n"),
            valid.replace("### Risks", "### Disagreements"),
            valid.replace("### Agreements", "### Agreements extra"),
        ):
            with self.assertRaises(ValueError):
                validate_report(invalid)
        data = json.loads(json.dumps(FIXTURES["stopped_report"]))
        data["messages"][-1]["info"]["finish"] = "length"
        self.assertEqual(state(data), ("invalid", "msg-2"))
        with self.assertRaisesRegex(ValueError, "stopped normally"):
            report(data)

    def test_event_report_binds_session_and_latest_message(self):
        valid = report(FIXTURES["stopped_report"])

        def event(text, message="msg-2", session="ses-1", part="part-1"):
            return json.dumps({"type": "text", "sessionID": session, "part": {
                "id": part, "messageID": message, "type": "text", "text": text,
            }})

        self.assertEqual(event_report(event(valid), "ses-1", "msg-2"), valid)
        stream = event(valid, "msg-old") + "\n" + event(valid, session="ses-other")
        with self.assertRaisesRegex(ValueError, "No text event"):
            event_report(stream, "ses-1", "msg-2")
        stream += "\n" + event("Done")
        with self.assertRaises(ValueError):
            event_report(stream, "ses-1", "msg-2")

    def test_event_report_supports_chunks_and_cumulative_snapshots(self):
        valid = report(FIXTURES["stopped_report"])

        def stream(texts):
            return "\n".join(json.dumps({"type": "text", "sessionID": "ses-1", "part": {
                "id": "part-1", "messageID": "msg-2", "type": "text", "text": text,
            }}) for text in texts)

        for texts in ([valid[:30], valid[30:]], [valid[:30], valid], [valid, valid]):
            self.assertEqual(event_report(stream(texts), "ses-1", "msg-2"), valid)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            event_report(stream([valid]) + '\n{"type":', "ses-1", "msg-2")

    def test_run_ready_rejects_other_runs_or_active_dispatches(self):
        ready = {"runId": "run-1", "sessionID": "ses-1", "rounds": 2, "status": "ready", "dispatches": []}
        run_ready(ready, "run-1", "ses-1", 2)
        for overrides in ({"status": "active"}, {"runId": "wrong"}, {"rounds": 1}, {"dispatches": [{"status": "active"}]}):
            with self.assertRaises(ValueError):
                run_ready(ready | overrides, "run-1", "ses-1", 2)

    def test_report_is_extracted_from_ansi_run_output(self):
        text = "tool log\n\x1b[0m## Council Report\n\n" + "\n\n".join(
            f"### {section}\n{index}"
            for index, section in enumerate((
                "Participant findings",
                "Agreements",
                "Disagreements",
                "Risks",
                "Falsification tests",
                "Unresolved questions",
            ), start=1)
        ) + "\x1b[0m"
        extracted = report_output(text)
        self.assertTrue(extracted.startswith("## Council Report"))
        self.assertNotIn("\x1b", extracted)

    def test_session_title_must_match_once(self):
        sessions = [{"id": "ses-1", "title": "wanted"}]
        self.assertEqual(find_session(sessions, "wanted"), "ses-1")
        with self.assertRaisesRegex(ValueError, "could not identify"):
            find_session(sessions, "missing")


if __name__ == "__main__":
    unittest.main()
