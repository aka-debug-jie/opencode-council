#!/usr/bin/env python3
"""CouncilBench: frozen pilot, sequential calls, blinded human scoring. Stdlib only."""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
DS = "opencode-go/deepseek-v4-pro"
LUNA = "opencode-go/gpt-5.6-luna"
METHOD = {
    "version": "0.1", "single_model": DS, "weak_model": LUNA,
    "order": ["shared", "H+D", "H Alone", "S1", "S2"],
    "council_participants": "four product defaults", "council_rounds": 2,
    "s2_min_searches": 2, "s2_max_searches": 10,
    "token_cap": 5000000, "time_cap_seconds": 3600,
    "council_timeout_seconds": 600, "single_timeout_seconds": 300,
    "matching_tolerance": 0.20, "answer_word_guidance": 600,
    "budget_semantics": "observable usage; sequential call-boundary stop, not hard token cutoff",
    "paper_PCIR": "paper KIR; same complete critical-insight denominator",
    "MNY": "human candidates novel AND grounded AND testable / all human-audited candidates; null if none",
}


class BenchError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise BenchError(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    """Atomic status replacement; callers own a new output or acquired lease."""
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def relative_file(root, name):
    require(isinstance(name, str) and name and not Path(name).is_absolute(), "asset path must be relative")
    require(".." not in Path(name).parts, "asset path traversal")
    root = Path(root).resolve()
    path = root / name
    require(path.is_relative_to(root) and path.is_file(), f"missing asset: {name}")
    require(all(not part.is_symlink() for part in [path, *path.parents] if part != root.parent), "symlink asset not allowed")
    require(path.resolve().is_relative_to(root), "asset escapes task directory")
    return path


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def validate_task(task, rubric, directory):
    require(isinstance(task, dict) and isinstance(rubric, dict), "task and rubric must be objects")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", task.get("id", "")) is not None, "invalid task ID")
    require(task.get("version") == "0.1" and task.get("kind") in ("technical", "paper"), "invalid task version/kind")
    require(nonempty(task.get("prompt")), "empty task prompt")
    materials = task.get("materials")
    require(isinstance(materials, list) and materials, "materials required")
    material_ids = []
    for material in materials:
        require(isinstance(material, dict), "invalid material")
        require(nonempty(material.get("id")) and nonempty(material.get("title")), "material ID/title required")
        require(nonempty(material.get("text")) or nonempty(material.get("file")), "material text/file required")
        material_ids.append(material["id"])
        if "file" in material:
            filename = material["file"]
            require(nonempty(filename) and Path(filename).suffix == ".txt" and not any(part.startswith(".") for part in Path(filename).parts), "pilot material files must be .txt with no hidden/path-traversal components")
            relative_file(directory, material["file"]).read_text(encoding="utf-8")
    require(len(set(material_ids)) == len(material_ids), "duplicate material IDs")
    sources = task.get("sources", [])
    require(isinstance(sources, list), "sources must be a list")
    source_ids = []
    for source in sources:
        require(isinstance(source, dict) and nonempty(source.get("id")) and nonempty(source.get("url")), "source ID/URL required")
        source_ids.append(source["id"])
        if "sha256" in source:
            require(re.fullmatch(r"[0-9a-f]{64}", source["sha256"]) is not None, "invalid source SHA256")
    require(len(source_ids) == len(set(source_ids)), "duplicate source IDs")
    require(rubric.get("task_id") == task["id"] and rubric.get("status") in ("draft", "reviewed"), "rubric task/status mismatch")
    all_ids = []
    for key, low, high in (("critical_insights", 5, 10), ("catastrophic_risks", 2, 4)):
        entries = rubric.get(key)
        require(isinstance(entries, list) and low <= len(entries) <= high, f"{key} count must be {low}-{high}")
        for entry in entries:
            require(isinstance(entry, dict) and nonempty(entry.get("id")) and nonempty(entry.get("description")) and bool(entry.get("evidence")), f"invalid {key} entry")
            all_ids.append(entry["id"])
    require(len(all_ids) == len(set(all_ids)), "duplicate rubric IDs")
    for key, low, high in (("competing_solutions", 2, 3), ("high_value_insights", 1, 3), ("success_criteria", 1, 100)):
        entries = rubric.get(key)
        require(isinstance(entries, list) and low <= len(entries) <= high and all(nonempty(x) for x in entries), f"invalid {key}")


def source_files(root):
    paths = []
    for name in ("index.ts", "config.yaml", "package.json", "package-lock.json", "tsconfig.json", "benchmark/engine.py", "benchmark/live.py", "benchmark/fetch_papers.py", "benchmark/snapshot_models.py", "benchmark/model-catalog.json", "benchmark/dependencies/package.json", "benchmark/dependencies/package-lock.json"):
        path = root / name
        if path.is_file():
            paths.append(path)
    for directory in ("src", "scripts", "skills/codex-council", ".opencode/agents", ".opencode/commands"):
        if (root / directory).is_dir():
            paths.extend(p for p in (root / directory).rglob("*") if p.is_file() and p.suffix in (".ts", ".py", ".sh", ".md", ".json", ".yaml"))
    return sorted(set(paths))


def prepare(output, tasks_root=None, source_root=ROOT, task_ids=None):
    output, source_root = Path(output).absolute(), Path(source_root).resolve()
    tasks_root = Path(tasks_root or source_root / "benchmark/tasks").resolve()
    require(not output.exists(), "prepare output already exists; never overwrite a frozen bundle")
    task_paths = sorted(tasks_root.glob("*/task.json"))
    require(task_paths, "no task.json files found")
    candidates = []
    for task_path in task_paths:
        task = read_json(task_path)
        require(isinstance(task, dict) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", task.get("id", "")) is not None, "invalid task ID")
        candidates.append((task_path, task))
    require(len({task["id"] for _, task in candidates}) == len(candidates), "duplicate task IDs")
    if task_ids is not None:
        require(isinstance(task_ids, (list, tuple)) and task_ids, "task_ids must be a non-empty list when provided")
        require(all(isinstance(task_id, str) for task_id in task_ids), "task_ids must contain strings")
        require(len(set(task_ids)) == len(task_ids), "duplicate requested task IDs")
        known_ids = {task["id"] for _, task in candidates}
        unknown_ids = sorted(set(task_ids) - known_ids)
        require(not unknown_ids, "unknown task IDs: " + ", ".join(unknown_ids))
        requested = set(task_ids)
        candidates = [row for row in candidates if row[1]["id"] in requested]
    tasks = []
    for task_path, task in candidates:
        rubric = read_json(task_path.with_name("rubric.json"))
        validate_task(task, rubric, task_path.parent)
        tasks.append((task_path, task, rubric))
    output.mkdir(parents=True)
    originals = {}
    for task_path, task, _ in tasks:
        target = output / "tasks" / task["id"]
        target.mkdir(parents=True)
        sidecars = ["sources.json"] if (task_path.parent / "sources.json").is_file() else []
        for name in ("task.json", "rubric.json", *sidecars, *[m["file"] for m in task["materials"] if "file" in m]):
            original = relative_file(task_path.parent, name)
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, destination)
            originals[str(destination.relative_to(output))] = str(original)
    for original in source_files(source_root):
        require(not original.is_symlink(), "runtime symlinks not allowed")
        destination = output / "source" / original.relative_to(source_root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, destination)
        originals[str(destination.relative_to(output))] = str(original)
    write_json(output / "method.json", METHOD)
    hashes = {str(p.relative_to(output)): digest(p) for p in sorted(output.rglob("*")) if p.is_file()}
    manifest = {"version": "0.1", "task_ids": [task["id"] for _, task, _ in tasks], "files": hashes, "originals": originals, "source_root": str(source_root)}
    write_json(output / "manifest.json", manifest)
    approval = digest(output / "manifest.json")
    (output / "REVIEW.md").write_text(
        "# Human review required\n\nReview all tasks, source dossiers, draft rubrics, method.json, and frozen runtime. "
        "No live run has been authorized by prepare. --approval is deliberate bundle identity, not authentication. "
        "Review does not itself validate scientific judgments.\n\n"
        f"Manifest SHA256: `{approval}`\n\n"
        "After review, explicitly pass this SHA to run. Never generate approval automatically.\n", encoding="utf-8")
    return approval


def validate(bundle, check_originals=True):
    bundle = Path(bundle).resolve()
    manifest = read_json(bundle / "manifest.json")
    require(manifest.get("version") == "0.1", "invalid manifest")
    for name, expected in manifest["files"].items():
        require(digest(relative_file(bundle, name)) == expected, f"frozen hash mismatch: {name}")
    actual = {str(p.relative_to(bundle)) for directory in ("tasks", "source") for p in (bundle / directory).rglob("*") if p.is_file()}
    expected_files = {name for name in manifest["files"] if name.startswith(("tasks/", "source/"))}
    require(actual == expected_files, "unmanifested/missing frozen task or source files")
    require(read_json(bundle / "method.json") == METHOD, "method configuration differs from engine")
    if check_originals:
        for name, original in manifest["originals"].items():
            require(Path(original).is_file() and digest(original) == manifest["files"][name], f"original changed/missing: {original}")
        original_runtime = {str(p.relative_to(Path(manifest["source_root"]))) for p in source_files(Path(manifest["source_root"]))}
        frozen_runtime = {name.removeprefix("source/") for name in manifest["files"] if name.startswith("source/")}
        require(original_runtime == frozen_runtime, "runtime source set changed")
    ids = manifest["task_ids"]
    require(ids and len(ids) == len(set(ids)), "invalid task IDs in manifest")
    for task_id in ids:
        directory = bundle / "tasks" / task_id
        task = read_json(directory / "task.json")
        require(task["id"] == task_id, "manifest task ID mismatch")
        validate_task(task, read_json(directory / "rubric.json"), directory)
    return manifest


def base_prompt(task):
    chunks = [task["prompt"], "Use only the supplied public materials. Distinguish evidence from inference; state uncertainty. Final answer: at most 600 words (guidance, not truncation)."]
    for material in task["materials"]:
        chunks.append(f"Material {material['id']}: {material['title']}")
        if material.get("source_url"):
            chunks.append(f"Source: {material['source_url']}")
        if material.get("text"):
            chunks.append(material["text"])
        if material.get("file"):
            chunks.append(f"Read full public material at /task/{material['file']}")
    return "\n\n".join(chunks)


def token_value(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def total(records, field):
    values = [record.get(field) for record in records]
    return sum(values) if all(token_value(value) for value in values) else None


def mock_call(request, workdir):
    text="MOCK FIXTURE — NOT A MODEL RESULT\nEvidence must be checked.\nA bounded alternative requires explicit review."
    if request.get("final_answer"):
        text="\n\n".join("# "+section+"\nMOCK FIXTURE — NOT A MODEL RESULT" for section in ("Decision","Evidence and assumptions","Alternatives","Failure modes","Falsification tests","Open questions"))
    return {"text": text, "output_contract": {"valid": True, "error": None} if request.get("final_answer") else None,
            "status": "ok", "usage": {"input": 60, "output": 30, "reasoning": 10, "cache_read": 0, "cache_write": 0},
            "matching_tokens": 100, "observable_tokens": 100, "elapsed_seconds": 0.01,
            "session_ids": ["mock-" + request["id"]], "provenance": {"mock": True}}


def execute(bundle, output, approval, adapter, token_cap=500000, time_cap=3600, mock=False):
    bundle, output = Path(bundle).resolve(), Path(output).absolute()
    manifest = validate(bundle)
    require(approval == digest(bundle / "manifest.json"), "approval SHA does not match reviewed manifest")
    require(0 < token_cap <= METHOD["token_cap"] and 0 < time_cap <= METHOD["time_cap_seconds"], "budgets may only be lowered")
    require(not output.exists(), "run output already exists; recovery/re-run is forbidden")
    lease = bundle / ".writer.lock"
    try:
        fd = os.open(lease, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise BenchError("bundle already has a writer lease; no automatic recovery") from None
    os.close(fd)
    claim = bundle / (".mock.execution.json" if mock else ".live.execution.json")
    try:
        require(not claim.exists(), "bundle already executed in this mode; no duplicate execution/recovery")
        output.mkdir(parents=True)
        write_json(claim, {"output": str(output), "approval": approval, "mock": mock})
        state = {"version": "0.1", "mock": mock, "approval": approval, "bundle": str(bundle), "status": "running", "calls": [], "answers": [], "token_cap": token_cap, "time_cap_seconds": time_cap, "accounted_observable_tokens": 0}
        started = time.monotonic()
        write_json(output / "run.json", state)
        private = output / "private"
        private.mkdir()
        blind_dir = output / "blinded"
        blind_dir.mkdir()
        answer_map = {}

        def persist():
            state["elapsed_seconds"] = time.monotonic() - started
            write_json(output / "run.json", state)

        def dispatch(task, label, kind, model, prompt, final_answer=False):
            require(state["accounted_observable_tokens"] < token_cap, "observable token budget reached at call boundary")
            remaining = time_cap - (time.monotonic() - started)
            require(remaining >= 1, "wall-clock budget reached at call boundary")
            request_id = f"{task['id']}-{len(state['calls']) + 1:03d}"
            material_files = {m["file"]: relative_file(bundle / "tasks" / task["id"], m["file"]).read_text(encoding="utf-8") for m in task["materials"] if "file" in m}
            stage_timeout = METHOD["council_timeout_seconds"] if kind == "council" else METHOD["single_timeout_seconds"]
            request = {"id": request_id, "kind": kind, "model": model, "prompt": prompt, "timeout_seconds": min(stage_timeout, max(1, int(remaining))), "materials": material_files, "final_answer": final_answer}
            workdir = private / request_id
            workdir.mkdir()
            write_json(workdir / "request.json", request)
            record = {"id": request_id, "task_id": task["id"], "label": label, "model": model, "status": "dispatching", "request_sha256": digest(workdir / "request.json")}
            state["calls"].append(record)
            state["status"] = "dispatching_no_resume"
            persist()  # An interrupted dispatch is terminal; execute never resumes.
            call_started = time.monotonic()
            try:
                result = adapter(request, workdir)
                require(isinstance(result, dict), "adapter result must be an object")
                write_json(workdir / "result.json", result)
                record.update(result)
                if token_value(result.get("observable_tokens")):
                    state["accounted_observable_tokens"] += result["observable_tokens"]
                elif token_value(result.get("known_observable_tokens")):
                    state["accounted_observable_tokens"] += result["known_observable_tokens"]
                    state["observable_usage_incomplete"] = True
                require(result.get("status") == "ok", result.get("error") or f"adapter failed: {request_id}")
                require(not result.get("error"), result.get("error") or "adapter error on successful result")
                require(nonempty(result.get("text")), "adapter returned empty answer")
                require(isinstance(result.get("usage"), dict), "missing usage")
                require(all(key in result["usage"] and (result["usage"][key] is None or token_value(result["usage"][key])) for key in ("input", "output", "reasoning", "cache_read", "cache_write")), "invalid usage categories")
                require(token_value(result.get("observable_tokens")), "unknown observable usage; stopping before another call")
                require(result.get("matching_tokens") is None or token_value(result.get("matching_tokens")), "invalid matching usage")
                require(isinstance(result.get("session_ids"), list) and isinstance(result.get("provenance"), dict), "missing provenance/session IDs")
                require(isinstance(result.get("elapsed_seconds"), (int, float)) and not isinstance(result["elapsed_seconds"], bool) and math.isfinite(result["elapsed_seconds"]) and result["elapsed_seconds"] >= 0, "invalid elapsed time")
                record["measured_elapsed_seconds"] = time.monotonic() - call_started
                state["status"] = "running"
                persist()
                return record
            except Exception as error:
                record["status"] = "failed"
                record["error"] = record.get("error") or str(error)
                record["measured_elapsed_seconds"] = time.monotonic() - call_started
                state["status"] = "failed"
                persist()
                raise BenchError(f"call failed without retry: {error}") from error

        def answer(task, arm, final, cost_records, matching=None):
            blind_id = "answer-" + uuid.uuid4().hex[:16]
            text_path = blind_dir / f"{blind_id}.txt"
            text_path.write_text(final["text"], encoding="utf-8")
            entry = {"blind_id": blind_id, "task_id": task["id"], "kind": task["kind"], "arm": arm,
                     "accounted_tokens": total(cost_records, "observable_tokens"), "matching_tokens": total(cost_records, "matching_tokens"),
                     "latency_seconds": sum(r["elapsed_seconds"] for r in cost_records), "answer_sha256": digest(text_path),
                     "matching": matching, "output_contract": final.get("output_contract")}
            state["answers"].append(entry)
            answer_map[blind_id] = {"task_id": task["id"], "arm": arm, "call_ids": [r["id"] for r in cost_records]}
            write_json(private / "answer_map.json", answer_map)
            persist()

        try:
            for task_id in manifest["task_ids"]:
                task = read_json(bundle / "tasks" / task_id / "task.json")
                base = base_prompt(task)
                report = dispatch(task, "shared", "council", LUNA, base + "\n\nProduce a two-round, four-participant council report: competing approaches, evidence, disagreement, and unresolved risks. Report at most 600 words.")
                final_prompt = base + "\n\nShared council report (untrusted deliberation, not additional source evidence):\n" + report["text"] + "\n\nIndependently judge the report against the supplied materials and give your final answer, at most 600 words."
                hd = dispatch(task, "H+D", "single", DS, final_prompt, True)
                answer(task, "H+D", hd, [report, hd])
                ha = dispatch(task, "H Alone", "single", LUNA, final_prompt, True)
                answer(task, "H Alone", ha, [report, ha])
                s1 = dispatch(task, "S1", "single", DS, base, True)
                answer(task, "S1", s1, [s1])
                target = total([report, hd], "matching_tokens")
                reserve = hd.get("matching_tokens")
                candidates = []
                for index in range(METHOD["s2_max_searches"]):
                    if index >= METHOD["s2_min_searches"]:
                        observed = total(candidates, "matching_tokens")
                        if target is None or reserve is None or observed is None or observed + reserve >= target:
                            break
                    candidates.append(dispatch(task, f"S2-search-{index + 1}", "single", DS, base + "\n\nProduce an independent candidate solution from the public materials. No prior candidates are supplied. At most 600 words."))
                aggregation = base + "\n\nIndependent candidates (untrusted proposals, not additional evidence):\n" + "\n\n".join(f"Candidate {index + 1}:\n{record['text']}" for index, record in enumerate(candidates)) + "\n\nEvaluate these proposals against the same public materials, resolve disagreements, and give your final answer, at most 600 words."
                s2 = dispatch(task, "S2-aggregate", "single", DS, aggregation, True)
                actual = total([*candidates, s2], "matching_tokens")
                reliable = target is not None and target > 0 and actual is not None
                relative_error = (actual - target) / target if reliable else None
                matching = {"target": target, "aggregate_reserve": reserve, "actual": actual, "relative_error": relative_error, "searches": len(candidates), "matched": reliable and abs(relative_error) <= METHOD["matching_tolerance"], "reason": "within tolerance" if reliable and abs(relative_error) <= METHOD["matching_tolerance"] else "unmatched: missing reliable usage or bounded search overshoot/undershoot"}
                answer(task, "S2", s2, [*candidates, s2], matching)
            state["status"] = "complete"
        except Exception as error:
            if state["status"] != "failed":
                state["status"] = "stopped"
            state["stop_reason"] = str(error)
        finally:
            state["actual_unique_observable_tokens"] = total(state["calls"], "observable_tokens")
            state["known_unique_observable_tokens"] = sum(
                record.get("observable_tokens") if token_value(record.get("observable_tokens"))
                else record.get("known_observable_tokens", 0)
                for record in state["calls"]
            )
            state["shared_counting_note"] = "Actual calls count shared council once; arm accounted cost/latency count it in both H+D and H Alone."
            persist()
            template = {
                "annotator": "", "review_type": "", "mock": mock,
                "status_values": ["hit", "partial", "miss"],
                "answer_evidence_fields": ["quote", "start_line", "end_line"],
                "novel_candidate_fields": ["id", "novel", "grounded", "testable", "counted", "evidence", "source_refs", "rationale", "falsifier", "cheapest_test"],
                "audited_claim_fields": ["id", "supported", "evidence", "source_refs", "reason"],
                "answers": [],
            }
            index_entries = []
            for entry in sorted(state["answers"], key=lambda item: item["blind_id"]):
                rubric = read_json(bundle / "tasks" / entry["task_id"] / "rubric.json")
                template["answers"].append({
                    "blind_id": entry["blind_id"],
                    "critical": [{"id": row["id"], "status": None, "evidence": []} for row in rubric["critical_insights"]],
                    "risks": [{"id": row["id"], "status": None, "evidence": []} for row in rubric["catastrophic_risks"]],
                    "novel_candidates": [], "claims": [], "task_success": None,
                    "decision_evidence": [], "decisive_failure_evidence": [],
                    "harmful_recommendations": [],
                })
                index_entries.append({"blind_id": entry["blind_id"], "task_id": entry["task_id"], "file": entry["blind_id"] + ".txt"})
            expected_answers = len(manifest["task_ids"]) * 4
            write_json(blind_dir / "index.json", {"mock": mock, "run_status": state["status"],
                       "expected_answers": expected_answers, "available_answers": len(index_entries),
                       "complete": state["status"] == "complete" and len(index_entries) == expected_answers,
                       "answers": index_entries})
            write_json(output / "annotations.template.json", template)
        return state
    finally:
        lease.unlink()


def check_evidence(evidence, lines, needed):
    require(isinstance(evidence, list) and (bool(evidence) or not needed), "answer quote evidence required")
    for entry in evidence:
        require(isinstance(entry, dict), "invalid evidence")
        start, end, quote = entry.get("start_line"), entry.get("end_line"), entry.get("quote")
        require(token_value(start) and token_value(end) and 1 <= start <= end <= len(lines), "invalid evidence line span")
        require(nonempty(quote) and quote in "\n".join(lines[start - 1:end]), "quote not found in specified answer lines")


def judgment_status(item, legacy_boolean):
    status = item.get("status")
    if status is not None:
        require(status in ("hit", "partial", "miss"), "status must be hit, partial, or miss")
        if legacy_boolean in item:
            require(type(item[legacy_boolean]) is bool, f"explicit {legacy_boolean} boolean required")
            require(item[legacy_boolean] == (status == "hit"), f"status conflicts with {legacy_boolean}")
        return status
    require(type(item.get(legacy_boolean)) is bool, f"explicit status or legacy {legacy_boolean} boolean required")
    return "hit" if item[legacy_boolean] else "miss"


def score(run_dir, annotations, output):
    run_dir, output = Path(run_dir).resolve(), Path(output).absolute()
    require(not output.exists(), "score output already exists")
    state, annotation = read_json(run_dir / "run.json"), read_json(annotations)
    require(state["status"] == "complete", "only complete runs can be scored")
    require(nonempty(annotation.get("annotator")), "annotator required")
    require(annotation.get("review_type") in ("human", "ai-assisted"), "review_type must be human or ai-assisted")
    bundle = Path(state["bundle"])
    manifest = validate(bundle, check_originals=False)
    require(state["approval"] == digest(bundle / "manifest.json"), "run bundle identity changed")
    entries = annotation.get("answers")
    require(isinstance(entries, list), "answer annotations required")
    answers = {entry["blind_id"]: entry for entry in state["answers"]}
    expected_pairs = {(task_id, arm) for task_id in manifest["task_ids"]
                      for arm in ("H+D", "H Alone", "S1", "S2")}
    actual_pairs = {(entry.get("task_id"), entry.get("arm")) for entry in state["answers"]}
    require(len(state["answers"]) == len(expected_pairs) and actual_pairs == expected_pairs,
            "complete run must contain exactly four scored arms per task")
    require(len(entries) == len(answers) and {entry.get("blind_id") for entry in entries} == set(answers), "annotate every blind answer exactly once")
    rows = []
    for entry in entries:
        answer = answers[entry["blind_id"]]
        answer_path = run_dir / "blinded" / (entry["blind_id"] + ".txt")
        require(digest(answer_path) == answer["answer_sha256"], "blind answer mutated")
        lines = answer_path.read_text(encoding="utf-8").splitlines()
        rubric = read_json(bundle / "tasks" / answer["task_id"] / "rubric.json")
        task = read_json(bundle / "tasks" / answer["task_id"] / "task.json")
        source_ids = {item["id"] for item in task["materials"] + task.get("sources", [])}
        counts = {}
        for field, rubric_field, legacy_boolean in (("critical", "critical_insights", "present"), ("risks", "catastrophic_risks", "recognized")):
            judgments = entry.get(field)
            expected = {item["id"] for item in rubric[rubric_field]}
            require(isinstance(judgments, list) and len(judgments) == len(expected) and {item.get("id") for item in judgments} == expected, f"{field} must cover exact rubric IDs")
            statuses = []
            for item in judgments:
                status = judgment_status(item, legacy_boolean)
                check_evidence(item.get("evidence"), lines, status in ("hit", "partial"))
                statuses.append(status)
            counts[field] = {status: statuses.count(status) for status in ("hit", "partial", "miss")}
        for field, booleans in (("novel_candidates", ("novel", "grounded", "testable")), ("claims", ("supported",))):
            judgments = entry.get(field)
            require(isinstance(judgments, list), f"{field} audit list required")
            require(all(nonempty(item.get("id")) for item in judgments) and len({item["id"] for item in judgments}) == len(judgments), f"duplicate/empty {field} IDs")
            for item in judgments:
                require(all(type(item.get(boolean)) is bool for boolean in booleans), f"explicit {booleans} booleans required")
                check_evidence(item.get("evidence"), lines, True)
                refs = item.get("source_refs", [])
                require(isinstance(refs, list) and all(ref in source_ids for ref in refs), "invalid source_refs; use public material/source IDs")
                require(bool(refs) or not item.get("grounded", item.get("supported", False)), "grounded/supported judgment requires source_refs")
                if field == "novel_candidates":
                    require(all(nonempty(item.get(key)) for key in ("rationale", "falsifier", "cheapest_test")), "candidate rationale/falsifier/cheapest_test required")
                    counted = all(item[boolean] for boolean in booleans)
                    if "counted" in item:
                        require(type(item["counted"]) is bool and item["counted"] == counted, "counted must equal novel AND grounded AND testable")
                else:
                    require(nonempty(item.get("reason")), "audited factual claim reason required")
            counts[field] = (sum(all(item[boolean] for boolean in booleans) for item in judgments), len(judgments))
        require(type(entry.get("task_success")) is bool, "explicit task_success boolean required")
        if "decision_evidence" in entry or "decisive_failure_evidence" in entry:
            check_evidence(entry.get("decision_evidence"), lines, entry["task_success"])
            check_evidence(entry.get("decisive_failure_evidence"), lines, not entry["task_success"])
        else:
            check_evidence(entry.get("success_evidence"), lines, True)
        harmful = entry.get("harmful_recommendations", [])
        require(isinstance(harmful, list), "invalid harmful recommendation annotations")
        for item in harmful:
            check_evidence(item.get("evidence"), lines, True)
        critical_counts, risk_counts = counts["critical"], counts["risks"]
        critical_n, critical_d = critical_counts["hit"], sum(critical_counts.values())
        risk_d = sum(risk_counts.values())
        conservative_risk_misses = risk_counts["partial"] + risk_counts["miss"]
        novel_n, novel_d = counts["novel_candidates"]
        supported_n, claim_d = counts["claims"]
        rows.append({**answer, "KIR": critical_n / critical_d, "KIR_n": critical_n, "KIR_d": critical_d,
                     "KIR_partial_count": critical_counts["partial"],
                     "PCIR": critical_n / critical_d if answer["kind"] == "paper" else None,
                     "catastrophic_miss_rate": conservative_risk_misses / risk_d, "catastrophic_miss_n": conservative_risk_misses, "catastrophic_miss_d": risk_d,
                     "catastrophic_status_miss_n": risk_counts["miss"], "catastrophic_partial_count": risk_counts["partial"],
                     "MNY": novel_n / novel_d if novel_d else None, "MNY_n": novel_n, "MNY_d": novel_d,
                     "unsupported_claim_rate": (claim_d - supported_n) / claim_d if claim_d else None, "unsupported_claim_n": claim_d - supported_n, "unsupported_claim_d": claim_d,
                     "TaskSuccess": int(entry["task_success"]), "harmful_recommendations": len(harmful)})
    result = {"version": "0.1", "mock": state["mock"], "run": str(run_dir), "run_sha256": digest(run_dir / "run.json"), "annotation_sha256": digest(annotations), "annotator": annotation["annotator"], "review_type": annotation["review_type"], "approval": state["approval"], "actual_unique_observable_tokens": state["actual_unique_observable_tokens"], "rows": rows}
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, result)
    return result


def summarize(scored, output):
    result, output = read_json(scored), Path(output).absolute()
    require(not output.exists(), "summary output already exists")
    rows = result["rows"]
    require(rows, "no human-scored rows")
    output.mkdir(parents=True)
    fields = ["task_id", "arm", "blind_id", "KIR", "KIR_n", "KIR_d", "KIR_partial_count", "PCIR", "catastrophic_miss_rate", "catastrophic_miss_n", "catastrophic_miss_d", "catastrophic_status_miss_n", "catastrophic_partial_count", "MNY", "MNY_n", "MNY_d", "unsupported_claim_rate", "unsupported_claim_n", "unsupported_claim_d", "TaskSuccess", "harmful_recommendations", "accounted_tokens", "matching_tokens", "latency_seconds"]
    with (output / "scores.tsv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, delimiter="\t", extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: "NA" if row.get(key) is None else row.get(key) for key in fields})
    heading = "MOCK FIXTURE — NOT EMPIRICAL RESULTS" if result["mock"] else ("Human-scored pilot" if result["review_type"] == "human" else "AI-assisted blind review — provisional, not human scoring") + " (descriptive; no significance claims)"
    notes = [f"# {heading}", "", f"Annotator: {result['annotator']}", f"Review type: {result['review_type']}", f"Actual unique observable tokens: {result['actual_unique_observable_tokens']}", "", "Per-arm accounted tokens include shared council cost in each of H+D and H Alone; actual cost includes it once. KIR/PCIR count only hit statuses; partial critical insights are reported separately. The catastrophic-miss numerator conservatively counts both partial and miss statuses, while raw status-miss and partial counts are also reported. PCIR equals KIR for paper tasks only. MNY and unsupported-claim rate are NA when their audited denominator is zero. Grounded/support source references and novelty/testability are reviewer judgments; ID/quote checks do not prove them. Frontier is descriptive within each task (higher KIR, lower accounted observable tokens), not an uncertainty-aware efficiency claim.", "", "| Task | Arm | KIR | Tokens | TaskSuccess |", "|---|---|---:|---:|---:|"]
    for row in rows:
        notes.append(f"| {row['task_id']} | {row['arm']} | {row['KIR']:.3f} | {row['accounted_tokens']} | {row['TaskSuccess']} |")
    (output / "summary.md").write_text("\n".join(notes) + "\n", encoding="utf-8")
    task_ids = sorted({row["task_id"] for row in rows})
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="{100 + 300 * len(task_ids)}" viewBox="0 0 800 {100 + 300 * len(task_ids)}">', '<rect width="100%" height="100%" fill="white"/>', f'<text x="25" y="25" font-family="sans-serif" font-size="15">{html.escape(heading)}</text>']
    colors = {"S1": "#0072B2", "S2": "#009E73", "H+D": "#D55E00", "H Alone": "#CC79A7"}
    for index, task_id in enumerate(task_ids):
        group = [row for row in rows if row["task_id"] == task_id and row["accounted_tokens"] is not None]
        top = 70 + index * 300
        maximum = max([row["accounted_tokens"] for row in group] + [1]) * 1.15
        svg.extend([f'<text x="65" y="{top}" font-family="sans-serif">{html.escape(task_id)}</text>', f'<path d="M70 {top + 20} V{top + 220} H730" fill="none" stroke="black"/>', f'<text x="320" y="{top + 258}" font-family="sans-serif">Accounted observable tokens</text>', f'<text x="15" y="{top + 100}" font-family="sans-serif">KIR</text>'])
        for tick in (0, 0.5, 1):
            svg.append(f'<text x="35" y="{top + 223 - tick * 200}" font-family="sans-serif" font-size="12">{tick}</text>')
        frontier = [row for row in group if not any(other["accounted_tokens"] <= row["accounted_tokens"] and other["KIR"] >= row["KIR"] and (other["accounted_tokens"] < row["accounted_tokens"] or other["KIR"] > row["KIR"]) for other in group)]
        coords = lambda row: (70 + row["accounted_tokens"] / maximum * 660, top + 220 - row["KIR"] * 200)
        points = " ".join(f"{coords(row)[0]:.1f},{coords(row)[1]:.1f}" for row in sorted(frontier, key=lambda row: row["accounted_tokens"]))
        svg.append(f'<polyline points="{points}" fill="none" stroke="#777" stroke-dasharray="4 4"/>')
        for n, row in enumerate(group):
            x, y = coords(row)
            label = html.escape(f"{row['arm']} ({row['accounted_tokens']}, {row['KIR']:.2f})")
            svg.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" fill="{colors.get(row["arm"], "black")}"><title>{label}</title></circle>')
            svg.append(f'<text x="{x + 7:.1f}" y="{y - 8 - (n % 2) * 14:.1f}" font-family="sans-serif" font-size="11">{label}</text>')
    svg.append("</svg>")
    (output / "quality-cost.svg").write_text("\n".join(svg), encoding="utf-8")
    return {"rows": len(rows), "output": str(output)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("--output", required=True)
    prep.add_argument("--tasks")
    prep.add_argument("--task-id", action="append", dest="task_ids")
    check = commands.add_parser("validate")
    check.add_argument("--bundle", required=True)
    run = commands.add_parser("run")
    run.add_argument("--bundle", required=True)
    run.add_argument("--approval", required=True)
    run.add_argument("--output", required=True)
    run.add_argument("--mock", action="store_true")
    run.add_argument("--token-cap", type=int, default=500000)
    run.add_argument("--time-cap", type=int, default=METHOD["time_cap_seconds"])
    scorer = commands.add_parser("score")
    scorer.add_argument("--run", required=True)
    scorer.add_argument("--annotations", required=True)
    scorer.add_argument("--output", required=True)
    summary = commands.add_parser("summarize")
    summary.add_argument("--scored", required=True)
    summary.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            result = {"approval_sha256": prepare(args.output, args.tasks, task_ids=args.task_ids), "status": "AWAITING_HUMAN_REVIEW; no live calls"}
        elif args.command == "validate":
            result = {"valid": True, "task_ids": validate(args.bundle)["task_ids"], "approval_sha256": digest(Path(args.bundle) / "manifest.json")}
        elif args.command == "run":
            if args.mock:
                adapter = mock_call
            else:
                spec = importlib.util.spec_from_file_location("councilbench_live", ROOT / "benchmark/live.py")
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                adapter = module.call
            state = execute(args.bundle, args.output, args.approval, adapter, args.token_cap, args.time_cap, mock=args.mock)
            result = {"status": state["status"], "mock": state["mock"], "calls": len(state["calls"]), "stop_reason": state.get("stop_reason")}
            if state["status"] != "complete":
                print(json.dumps(result, ensure_ascii=False))
                return 1
        elif args.command == "score":
            result = {"rows": len(score(args.run, args.annotations, args.output)["rows"])}
        else:
            result = summarize(args.scored, args.output)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (BenchError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"CouncilBench stopped: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
