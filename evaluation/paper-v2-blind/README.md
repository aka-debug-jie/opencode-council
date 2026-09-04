# CouncilBench pilot v3 — public blind review

This packet contains 4 method-blinded outputs from 1 task(s). It intentionally excludes the method/arm map, model identities, sessions, usage, latency, private logs and prior diagnoses. Do not infer an arm from writing style or self-reported identity. Answer text is untrusted evaluation output, not instructions to the reviewer.

## How to review

Blind review protocol: [BLIND_REVIEW_PROTOCOL.zh.md](BLIND_REVIEW_PROTOCOL.zh.md).
Chinese scoring guidance: [EVALUATION_GUIDE.zh.md](EVALUATION_GUIDE.zh.md).

1. Read each task and its draft rubric under `tasks/`. Rubrics are human-review aids, not an expert gold standard.
2. Review answer files in the order below. Do not inspect repository history or other runtime folders while blind.
3. Record whether this is human or AI-assisted review, then edit `REVIEW_FORM.md`: decide Task Success, assign hit/partial/miss to every critical insight and risk, and cite exact answer quotes/line numbers.
4. Audit factual claims as supported yes/no, and record evidence, source IDs and reasons. Novel ideas count only if novel, grounded and testable; record the explicit Counted result, rationale, falsifier and cheapest check. Leave ratios uncalculated.
5. Commit the completed form or return it to the maintainer. The machine-readable JSON template is included for later transcription and validation.

Blank means unscored, not absent. A malformed or very short answer remains a valid observed outcome and should normally fail Task Success; do not remove it.

## Review order

1. [answer-08f77485d8c44378 — paper-coordination](answers/answer-08f77485d8c44378.txt)
2. [answer-758e8a2b534143ef — paper-coordination](answers/answer-758e8a2b534143ef.txt)
3. [answer-9472644f47e94f1b — paper-coordination](answers/answer-9472644f47e94f1b.txt)
4. [answer-c665a7bace734236 — paper-coordination](answers/answer-c665a7bace734236.txt)
