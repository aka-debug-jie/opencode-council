#!/usr/bin/env python3
import json
import re
import sys


REQUIRED_REPORT_SECTIONS = (
    "Participant findings",
    "Agreements",
    "Disagreements",
    "Risks",
    "Falsification tests",
    "Unresolved questions",
)
ANSI_ESCAPE_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def load_stdin():
    try:
        return json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def assistants(data):
    if not isinstance(data, dict) or not isinstance(data.get("messages", []), list):
        raise ValueError("OpenCode session export has an invalid message list")
    return [
        item for item in data.get("messages", [])
        if item.get("info", {}).get("role") == "assistant"
    ]


def state(data):
    if data is None:
        return "transient", ""
    messages = assistants(data)
    if not messages:
        return "wait", ""
    for message in messages:
        for part in message.get("parts", []):
            if part.get("type") == "tool" and part.get("state", {}).get("status") in {"pending", "running"}:
                return "wait", messages[-1].get("info", {}).get("id", "")
    latest = messages[-1]
    message_id = latest.get("info", {}).get("id", "")
    finish = latest.get("info", {}).get("finish", "")
    if finish == "tool-calls":
        return "continue", message_id
    if finish == "stop":
        return "stop", message_id
    if finish:
        return "invalid", message_id
    return "wait", message_id


def validate_report(text):
    text = text.strip()
    if not text.startswith("## Council Report\n"):
        raise ValueError("OpenCode session stopped without a Council Report")
    headings = list(re.finditer(r"(?m)^#{1,3} .+$", text))
    expected = ["## Council Report", *(f"### {section}" for section in REQUIRED_REPORT_SECTIONS)]
    if [match.group().rstrip() for match in headings] != expected:
        raise ValueError("Council Report must contain exactly six ordered sections and no extra top-level headings")
    for index, match in enumerate(headings[1:], start=1):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        if not text[match.end():end].strip():
            raise ValueError(f"Council Report section is empty: {REQUIRED_REPORT_SECTIONS[index - 1]}")
    return text


def report(data, expected_message_id=None):
    if data is None:
        raise ValueError("OpenCode session export is incomplete")
    messages = assistants(data)
    if not messages:
        raise ValueError("OpenCode session has no assistant response")
    if expected_message_id is not None and messages[-1].get("info", {}).get("id") != expected_message_id:
        raise ValueError("OpenCode raw export does not match the latest assistant message")
    if state(data)[0] != "stop" or messages[-1].get("info", {}).get("finish") != "stop":
        raise ValueError("Latest OpenCode assistant has not stopped normally")
    text = "\n".join(
        part.get("text", "")
        for part in messages[-1].get("parts", [])
        if part.get("type") == "text"
    ).strip()
    return validate_report(text)


def report_output(text):
    clean = ANSI_ESCAPE_RE.sub("", text)
    markers = list(re.finditer(r"(?m)^## Council Report\s*$", clean))
    for marker in reversed(markers):
        candidate = clean[marker.start():].strip()
        try:
            return validate_report(candidate)
        except ValueError:
            continue
    raise ValueError("OpenCode run output does not contain a complete Council Report")


def event_report(stream, session_id, message_id):
    """Accept only text for the final assistant, never an earlier report."""
    parts = {}
    for line in stream.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError("OpenCode JSON event stream is incomplete") from error
        if not isinstance(event, dict):
            raise ValueError("OpenCode JSON event is not an object")
        part = event.get("part", {})
        if (event.get("type") != "text" or event.get("sessionID") != session_id
                or part.get("messageID") != message_id or part.get("type") != "text"):
            continue
        text = part.get("text")
        if not isinstance(text, str):
            raise ValueError("OpenCode text event has no text")
        key = part.get("id", "anonymous")
        previous = parts.get(key, "")
        # OpenCode emits completed text parts; tolerate streamed chunks and
        # cumulative snapshots without ever selecting an older message.
        parts[key] = text if text.startswith(previous) else previous + text
    if not parts:
        raise ValueError("No text event matches the latest OpenCode assistant")
    return validate_report("\n".join(parts.values()))


def event_errors(stream):
    errors = []
    for line in stream.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "error":
            continue
        error = event.get("error", {})
        if isinstance(error, dict):
            message = error.get("data", {}).get("message") or error.get("message") or error.get("name")
        else:
            message = str(error)
        if message:
            errors.append(str(message)[:1500])
    return "\n".join(errors)


def run_ready(data, run_id, session_id, rounds):
    if not isinstance(data, dict):
        raise ValueError("Council run state is unavailable")
    if (data.get("runId") != run_id or data.get("sessionID") != session_id
            or data.get("rounds") != rounds or data.get("status") not in {"ready", "completed"}):
        raise ValueError("Council run is not ready for this session and round count")
    if any(item.get("status") == "active" for item in data.get("dispatches", [])):
        raise ValueError("Council run still has active dispatches")


def find_session(data, title):
    if not isinstance(data, list):
        raise ValueError("OpenCode session list is not a JSON array")
    matches = [item.get("id") for item in data if item.get("title") == title]
    if len(matches) != 1 or not isinstance(matches[0], str):
        raise ValueError("Council runner could not identify its OpenCode session")
    return matches[0]


def main():
    if len(sys.argv) < 2:
        raise ValueError("Expected state, report, report-output, or find-session")
    command = sys.argv[1]
    if command == "event-errors":
        text = event_errors(sys.stdin.read())
        if text:
            print(text)
        return
    if command == "report-output":
        print(report_output(sys.stdin.read()))
        return
    if command == "event-report" and len(sys.argv) == 4:
        print(event_report(sys.stdin.read(), sys.argv[2], sys.argv[3]))
        return
    data = load_stdin()
    if command == "state":
        decision, message_id = state(data)
        print(f"{decision}\t{message_id}")
        return
    if command == "report":
        print(report(data, sys.argv[2] if len(sys.argv) == 3 else None))
        return
    if command == "run-ready" and len(sys.argv) == 5:
        run_ready(data, sys.argv[2], sys.argv[3], int(sys.argv[4]))
        return
    if command == "find-session" and len(sys.argv) == 3:
        if data is None:
            raise ValueError("OpenCode session list is incomplete")
        print(find_session(data, sys.argv[2]))
        return
    raise ValueError("Expected state, report, report-output, or find-session TITLE")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
