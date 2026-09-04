"""Local mock-only protocol tests; no model, network, or credential access."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET


SPEC = importlib.util.spec_from_file_location("councilbench_engine", Path(__file__).resolve().parents[1] / "benchmark/engine.py")
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)


class CouncilBenchTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "repo"
        self.source.mkdir()
        self.task_dir = self.source / "benchmark/tasks/sample"
        (self.task_dir / "papers").mkdir(parents=True)
        (self.task_dir / "papers/a.txt").write_text("PUBLIC FULLTEXT ONLY", encoding="utf-8")
        self.task = {"id": "sample", "version": "0.1", "kind": "paper", "prompt": "Explain bounded coordination.", "materials": [{"id": "public1", "title": "Paper", "text": "Public dossier", "file": "papers/a.txt"}], "sources": [{"id": "source1", "url": "https://example.test/paper"}]}
        self.rubric = {"task_id": "sample", "status": "draft", "critical_insights": [{"id": f"I{i}", "description": f"HIDDEN_GOLD_INSIGHT_{i}", "evidence": "HIDDEN_GOLD_EVIDENCE"} for i in range(5)], "catastrophic_risks": [{"id": f"R{i}", "description": f"HIDDEN_GOLD_RISK_{i}", "evidence": "HIDDEN_GOLD_EVIDENCE"} for i in range(2)], "competing_solutions": ["Solution one", "Solution two"], "high_value_insights": ["hidden value"], "success_criteria": ["Human verified success"]}
        self.save_tasks()
        (self.source / "index.ts").write_text("// runtime fixture\n", encoding="utf-8")
        self.bundle, self.run = self.root / "bundle", self.root / "run"
        self.calls = []

    def save_tasks(self):
        engine.write_json(self.task_dir / "task.json", self.task)
        engine.write_json(self.task_dir / "rubric.json", self.rubric)

    def prepare(self):
        self.approval = engine.prepare(self.bundle, source_root=self.source)
        return self.approval

    def adapter(self, request, workdir):
        self.calls.append(copy.deepcopy(request))
        state = engine.read_json(self.run / "run.json")
        self.assertEqual(state["status"], "dispatching_no_resume")
        self.assertEqual(state["calls"][-1]["status"], "dispatching")
        result = engine.mock_call(request, workdir)
        result["text"] = f"Fixture answer for call {len(self.calls)}.\nEvidence must be checked.\nA bounded alternative requires explicit review."
        return result

    def execute(self, adapter=None, **kwargs):
        self.prepare()
        return engine.execute(self.bundle, self.run, self.approval, adapter or self.adapter, mock=True, **kwargs)

    def annotate(self):
        annotation = engine.read_json(self.run / "annotations.template.json")
        annotation["annotator"] = "Human fixture (not empirical scores)"
        evidence = [{"quote": "Evidence must be checked.", "start_line": 2, "end_line": 2}]
        for entry in annotation["answers"]:
            for index, insight in enumerate(entry["critical"]):
                insight["present"] = index < 3
                insight["evidence"] = evidence if insight["present"] else []
            for index, risk in enumerate(entry["risks"]):
                risk["recognized"] = index == 0
                risk["evidence"] = evidence if risk["recognized"] else []
            entry["task_success"] = False
            entry["success_evidence"] = evidence
        path = self.root / "human.json"
        engine.write_json(path, annotation)
        return path, annotation, evidence

    def test_prepare_gate_and_frozen_asset(self):
        engine.write_json(self.task_dir / "sources.json", {"fixture": "public provenance"})
        self.prepare()
        self.assertEqual(len(self.approval), 64)
        self.assertEqual(engine.validate(self.bundle)["task_ids"], ["sample"])
        self.assertEqual((self.bundle / "tasks/sample/papers/a.txt").read_text(), "PUBLIC FULLTEXT ONLY")
        self.assertEqual(engine.read_json(self.bundle / "tasks/sample/sources.json"), {"fixture": "public provenance"})
        self.assertFalse(self.run.exists())
        self.assertFalse((self.bundle / ".live.execution.json").exists())
        with self.assertRaisesRegex(engine.BenchError, "already exists"):
            engine.prepare(self.bundle, source_root=self.source)

    def test_routing_shared_prompt_independence_and_no_gold(self):
        state = self.execute()
        self.assertEqual(state["status"], "complete")
        self.assertEqual([record["label"] for record in state["calls"]], ["shared", "H+D", "H Alone", "S1", "S2-search-1", "S2-search-2", "S2-aggregate"])
        self.assertEqual([request["model"] for request in self.calls], [engine.LUNA, engine.DS, engine.LUNA, engine.DS, engine.DS, engine.DS, engine.DS])
        self.assertEqual([request["kind"] for request in self.calls], ["council"] + ["single"] * 6)
        self.assertEqual([request["timeout_seconds"] for request in self.calls], [600] + [300] * 6)
        self.assertEqual(self.calls[1]["prompt"], self.calls[2]["prompt"])
        self.assertIn("Fixture answer for call 1.", self.calls[1]["prompt"])
        self.assertEqual(self.calls[4]["prompt"], self.calls[5]["prompt"])
        for request in self.calls:
            self.assertNotIn("HIDDEN_GOLD", json.dumps(request))
            self.assertEqual(request["materials"], {"papers/a.txt": "PUBLIC FULLTEXT ONLY"})
        self.assertNotIn("Fixture answer for call", self.calls[4]["prompt"])
        self.assertNotIn("Fixture answer for call", self.calls[5]["prompt"])
        self.assertIn("Fixture answer for call 5.", self.calls[6]["prompt"])
        self.assertIn("Fixture answer for call 6.", self.calls[6]["prompt"])
        self.assertEqual(state["actual_unique_observable_tokens"], 700)
        arms = {answer["arm"]: answer for answer in state["answers"]}
        self.assertEqual({key: value["accounted_tokens"] for key, value in arms.items()}, {"H+D": 200, "H Alone": 200, "S1": 100, "S2": 300})
        self.assertAlmostEqual(arms["H+D"]["latency_seconds"], 0.02)
        self.assertEqual(arms["S2"]["matching"]["target"], 200)
        self.assertFalse(arms["S2"]["matching"]["matched"])
        self.assertEqual(arms["S2"]["matching"]["relative_error"], 0.5)

    def test_s2_stops_at_four_independent_searches(self):
        def adapter(request, workdir):
            result = self.adapter(request, workdir)
            result["matching_tokens"] = 10000 if request["kind"] == "council" else 100
            return result
        state = self.execute(adapter)
        self.assertEqual(len(self.calls), 9)
        self.assertEqual(len([r for r in state["calls"] if r["label"].startswith("S2-search")]), 4)
        self.assertEqual(state["answers"][-1]["matching"]["searches"], 4)
        self.assertFalse(state["answers"][-1]["matching"]["matched"])

    def test_unknown_matching_only_permits_minimum_and_flags_unmatched(self):
        def adapter(request, workdir):
            result = self.adapter(request, workdir)
            result["matching_tokens"] = None
            return result
        state = self.execute(adapter)
        self.assertEqual(state["status"], "complete")
        self.assertEqual(len(self.calls), 7)
        match = state["answers"][-1]["matching"]
        self.assertIsNone(match["relative_error"])
        self.assertIsNone(match["actual"])
        self.assertFalse(match["matched"])

    def test_approval_mismatch_dispatches_nothing(self):
        self.prepare()
        with self.assertRaisesRegex(engine.BenchError, "approval SHA"):
            engine.execute(self.bundle, self.run, "wrong", self.adapter)
        self.assertFalse(self.run.exists())
        self.assertEqual(self.calls, [])

    def test_mutated_frozen_rubric_rejected(self):
        self.prepare()
        path = self.bundle / "tasks/sample/rubric.json"
        path.write_text(path.read_text() + " ")
        with self.assertRaisesRegex(engine.BenchError, "hash mismatch"):
            engine.validate(self.bundle)

    def test_mutated_original_runtime_rejected(self):
        self.prepare()
        (self.source / "index.ts").write_text("// changed\n")
        with self.assertRaisesRegex(engine.BenchError, "original changed"):
            engine.validate(self.bundle)

    def test_new_runtime_file_rejected(self):
        self.prepare()
        (self.source / "src").mkdir()
        (self.source / "src/new.ts").write_text("// new\n")
        with self.assertRaisesRegex(engine.BenchError, "source set changed"):
            engine.validate(self.bundle)

    def test_unmanifested_frozen_file_rejected(self):
        self.prepare()
        (self.bundle / "tasks/sample/new.txt").write_text("unexpected\n")
        with self.assertRaisesRegex(engine.BenchError, "unmanifested"):
            engine.validate(self.bundle)

    def test_schema_limits_and_duplicate_ids(self):
        for key, bad in (("critical_insights", self.rubric["critical_insights"][:4]), ("catastrophic_risks", self.rubric["catastrophic_risks"][:1]), ("competing_solutions", ["only one"]), ("high_value_insights", [])):
            with self.subTest(key=key):
                rubric = {**self.rubric, key: bad}
                with self.assertRaises(engine.BenchError):
                    engine.validate_task(self.task, rubric, self.task_dir)
        rubric = copy.deepcopy(self.rubric)
        rubric["critical_insights"][1]["id"] = "I0"
        with self.assertRaisesRegex(engine.BenchError, "duplicate rubric"):
            engine.validate_task(self.task, rubric, self.task_dir)

    def test_assets_reject_escape_symlink_and_rubric(self):
        for filename in ("../rubric.json", "/etc/passwd", "rubric.json", ".opencode/opencode.json", "AGENTS.md", "papers/.hidden.txt", "../a.txt"):
            with self.subTest(filename=filename):
                task = copy.deepcopy(self.task)
                task["materials"][0]["file"] = filename
                with self.assertRaises(engine.BenchError):
                    engine.validate_task(task, self.rubric, self.task_dir)
        link = self.task_dir / "papers/link.txt"
        link.symlink_to(self.task_dir / "papers/a.txt")
        with self.assertRaisesRegex(engine.BenchError, "symlink"):
            engine.relative_file(self.task_dir, "papers/link.txt")

    def test_budget_limit_stops_before_next_call(self):
        state = self.execute(token_cap=100)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(state["status"], "stopped")
        self.assertIn("token budget", state["stop_reason"])
        self.assertEqual(state["actual_unique_observable_tokens"], 100)

    def test_budget_overshoot_is_recorded_not_hidden(self):
        state = self.execute(token_cap=50)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(state["actual_unique_observable_tokens"], 100)
        self.assertEqual(state["token_cap"], 50)

    def test_remaining_wall_time_caps_stage_timeout(self):
        self.execute(time_cap=100)
        self.assertTrue(all(1 <= call["timeout_seconds"] <= 100 for call in self.calls))

    def test_failed_call_known_cost_still_accounted(self):
        def adapter(request, workdir):
            result = self.adapter(request, workdir)
            result["status"] = "failed"
            return result
        state = self.execute(adapter)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(state["accounted_observable_tokens"], 100)
        self.assertEqual(state["actual_unique_observable_tokens"], 100)

    def test_time_boundary_stops_before_dispatch(self):
        self.prepare()
        with patch.object(engine.time, "monotonic", side_effect=[0, 2, 2, 2]):
            state = engine.execute(self.bundle, self.run, self.approval, self.adapter, time_cap=1, mock=True)
        self.assertEqual(self.calls, [])
        self.assertEqual(state["status"], "stopped")
        self.assertIn("wall-clock", state["stop_reason"])

    def test_unknown_observable_usage_fails_closed_without_retry(self):
        def adapter(request, workdir):
            result = self.adapter(request, workdir)
            result["observable_tokens"] = None
            result["usage"] = {key: None for key in result["usage"]}
            return result
        state = self.execute(adapter)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(state["status"], "failed")
        self.assertIsNone(state["actual_unique_observable_tokens"])
        self.assertIn("unknown observable usage", state["stop_reason"])

    def test_ok_status_with_error_is_failed_with_known_cost(self):
        def adapter(request, workdir):
            return {**self.adapter(request, workdir), "error": "trailing provider error"}
        state = self.execute(adapter)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(state["known_unique_observable_tokens"], 100)
        self.assertIn("trailing provider error", state["stop_reason"])

    def test_incomplete_blind_index_exposes_counts_without_arm_identity(self):
        self.execute(token_cap=200)
        index = engine.read_json(self.run / "blinded/index.json")
        self.assertEqual((index["run_status"], index["expected_answers"], index["available_answers"], index["complete"]),
                         ("stopped", 4, 1, False))
        self.assertNotIn("arm", json.dumps(index))

    def test_failed_call_no_retry_preserves_artifacts(self):
        def adapter(request, workdir):
            self.calls.append(request)
            return {"status": "failed", "error": "provider precise failure", "text": "failure fixture",
                    "provenance": {"reason": "provider failed"}, "observable_tokens": None,
                    "known_observable_tokens": 73}
        state = self.execute(adapter)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(state["stop_reason"], "call failed without retry: provider precise failure")
        self.assertEqual(state["accounted_observable_tokens"], 73)
        self.assertEqual(state["known_unique_observable_tokens"], 73)
        self.assertTrue(state["observable_usage_incomplete"])
        self.assertTrue((self.run / "private/sample-001/result.json").is_file())
        with self.assertRaisesRegex(engine.BenchError, "already executed"):
            engine.execute(self.bundle, self.root / "retry", self.approval, adapter, mock=True)
        self.assertEqual(len(self.calls), 1)

    def test_single_writer_and_same_output_refused(self):
        self.prepare()
        (self.bundle / ".writer.lock").touch()
        with self.assertRaisesRegex(engine.BenchError, "writer lease"):
            engine.execute(self.bundle, self.run, self.approval, self.adapter)
        self.assertEqual(self.calls, [])

    def test_blind_index_has_no_arm_or_model_mapping(self):
        state = self.execute()
        index = engine.read_json(self.run / "blinded/index.json")
        self.assertEqual(len(index["answers"]), 4)
        for entry in index["answers"]:
            self.assertEqual(set(entry), {"blind_id", "task_id", "file"})
            self.assertRegex(entry["blind_id"], r"^answer-[0-9a-f]{16}$")
        self.assertEqual((index["run_status"], index["expected_answers"], index["available_answers"], index["complete"]),
                         ("complete", 4, 4, True))
        mapping = engine.read_json(self.run / "private/answer_map.json")
        self.assertEqual(set(mapping), {answer["blind_id"] for answer in state["answers"]})
        self.assertEqual({entry["arm"] for entry in mapping.values()}, {"S1", "S2", "H+D", "H Alone"})

    def test_human_scoring_denominators_and_summary(self):
        self.execute()
        path, annotation, evidence = self.annotate()
        for entry in annotation["answers"]:
            entry["novel_candidates"] = [{"id": "N1", "novel": True, "grounded": True, "testable": True, "evidence": evidence, "source_refs": ["public1"], "rationale": "fixture", "falsifier": "counterexample", "cheapest_test": "unit test"}, {"id": "N2", "novel": False, "grounded": True, "testable": True, "evidence": evidence, "source_refs": ["public1"], "rationale": "fixture", "falsifier": "counterexample", "cheapest_test": "unit test"}]
            entry["claims"] = [{"id": "C1", "supported": True, "evidence": evidence, "source_refs": ["source1"]}, {"id": "C2", "supported": False, "evidence": evidence, "source_refs": []}]
        engine.write_json(path, annotation)
        scored_path = self.root / "scored.json"
        result = engine.score(self.run, path, scored_path)
        for row in result["rows"]:
            self.assertEqual((row["KIR_n"], row["KIR_d"], row["KIR"]), (3, 5, 0.6))
            self.assertEqual(row["PCIR"], 0.6)
            self.assertEqual(row["catastrophic_miss_rate"], 0.5)
            self.assertEqual((row["MNY_n"], row["MNY_d"], row["MNY"]), (1, 2, 0.5))
            self.assertEqual(row["unsupported_claim_rate"], 0.5)
            self.assertEqual(row["TaskSuccess"], 0)
        output = self.root / "summary"
        engine.summarize(scored_path, output)
        self.assertTrue((output / "scores.tsv").is_file())
        self.assertIn("MOCK FIXTURE", (output / "summary.md").read_text())
        ET.parse(output / "quality-cost.svg")

    def test_no_candidates_or_claims_is_null_not_zero(self):
        self.execute()
        path, _, _ = self.annotate()
        result = engine.score(self.run, path, self.root / "scored.json")
        for row in result["rows"]:
            self.assertIsNone(row["MNY"])
            self.assertIsNone(row["unsupported_claim_rate"])
            self.assertEqual(row["MNY_d"], 0)

    def test_unfilled_template_cannot_score(self):
        self.execute()
        with self.assertRaisesRegex(engine.BenchError, "human annotator"):
            engine.score(self.run, self.run / "annotations.template.json", self.root / "scored.json")

    def test_score_rejects_complete_status_with_missing_arm(self):
        self.execute()
        path, _, _ = self.annotate()
        state = engine.read_json(self.run / "run.json")
        state["answers"].pop()
        engine.write_json(self.run / "run.json", state)
        with self.assertRaisesRegex(engine.BenchError, "exactly four scored arms"):
            engine.score(self.run, path, self.root / "bad-score.json")

    def test_quote_span_and_boolean_validation(self):
        self.execute()
        path, annotation, _ = self.annotate()
        annotation["answers"][0]["critical"][0]["evidence"][0]["quote"] = "DOES NOT EXIST"
        engine.write_json(path, annotation)
        with self.assertRaisesRegex(engine.BenchError, "quote not found"):
            engine.score(self.run, path, self.root / "bad-score.json")

    def test_mutated_blind_answer_cannot_score(self):
        self.execute()
        path, annotation, _ = self.annotate()
        answer_path = self.run / "blinded" / (annotation["answers"][0]["blind_id"] + ".txt")
        answer_path.write_text("mutated")
        with self.assertRaisesRegex(engine.BenchError, "blind answer mutated"):
            engine.score(self.run, path, self.root / "bad-score.json")


if __name__ == "__main__":
    unittest.main()
