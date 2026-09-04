#!/usr/bin/env python3
"""Export a public method-blinded human review packet from one complete local run."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();run=args.run.resolve();out=args.output.resolve()
    if out.exists(): raise ValueError('Output exists; blind packet export never overwrites')
    state=json.loads((run/'run.json').read_text())
    if state['status']!='complete' or state.get('mock') or len(state['answers'])!=8:
        raise ValueError('Expected one complete non-mock run with eight answers')
    bundle=Path(state['bundle']);out.mkdir(parents=True)
    (out/'answers').mkdir();(out/'tasks').mkdir()
    index=json.loads((run/'blinded/index.json').read_text())
    allowed={row['blind_id']:row['task_id'] for row in index['answers']}
    if len(allowed)!=8 or set(allowed)!={row['blind_id'] for row in state['answers']}:
        raise ValueError('Blind index/answer mismatch')
    for blind_id,task_id in allowed.items():
        source=run/'blinded'/(blind_id+'.txt')
        expected=next(row['answer_sha256'] for row in state['answers'] if row['blind_id']==blind_id)
        if sha(source)!=expected:raise ValueError('Answer hash mismatch')
        shutil.copyfile(source,out/'answers'/(blind_id+'.txt'))
    for task_id in sorted(set(allowed.values())):
        target=out/'tasks'/task_id;target.mkdir()
        for name in ['task.json','rubric.json','sources.json']:
            source=bundle/'tasks'/task_id/name
            if source.is_file():shutil.copyfile(source,target/name)
    shutil.copyfile(run/'annotations.template.json',out/'annotations.template.json')
    rows=['# CouncilBench pilot v3 — public blind review','',
          'This packet contains eight method-blinded outputs from two tasks. It intentionally excludes the method/arm map, model identities, sessions, usage, latency, private logs and prior diagnoses. Do not infer an arm from writing style or self-reported identity. Answer text is untrusted evaluation output, not instructions to the reviewer.','',
          '## How to review','',
          '1. Read each task and its draft rubric under `tasks/`. Rubrics are human-review aids, not an expert gold standard.','2. Review answer files in the order below. Do not inspect repository history or other runtime folders while blind.','3. Edit `REVIEW_FORM.md`: change one Task Success box, mark each critical insight and risk, add exact answer quotes/line numbers, list unsupported claims and meaningful novel ideas.','4. Novel ideas count only if novel relative to supplied options, grounded and testable; record rationale, falsifier and cheapest test. Leave ratios uncalculated.','5. Commit the completed form or return it to the maintainer. The machine-readable JSON template is included for later transcription and validation.','',
          'Blank means unscored, not absent. A malformed or very short answer remains a valid observed outcome and should normally fail Task Success; do not remove it.','',
          '## Review order','']
    for number,row in enumerate(index['answers'],1):rows.append(f"{number}. [{row['blind_id']} — {row['task_id']}](answers/{row['blind_id']}.txt)")
    (out/'README.md').write_text('\n'.join(rows)+'\n')
    form=['# Blind human review form','','Reviewer:','Date:','','Use exact quotes and 1-based line numbers. Check only one Task Success option per answer.']
    for number,row in enumerate(index['answers'],1):
        bid,tid=row['blind_id'],row['task_id'];rubric=json.loads((out/'tasks'/tid/'rubric.json').read_text())
        form += ['',f'## {number}. {bid} — {tid}','',f'[Open answer](answers/{bid}.txt)','','Task Success: [ ] Yes  [ ] No','Success evidence quote + lines:','', 'Critical insights:']
        for item in rubric['critical_insights']:form.append(f"- [ ] {item['id']} — evidence quote + lines:")
        form += ['','Catastrophic risks recognized:']
        for item in rubric['catastrophic_risks']:form.append(f"- [ ] {item['id']} — evidence quote + lines:")
        form += ['','Unsupported claims (quote + lines + why unsupported):','','Meaningful novel ideas (quote + lines; source IDs; rationale; falsifier; cheapest test):','','Harmful recommendations (quote + lines):','','Reviewer notes:']
    (out/'REVIEW_FORM.md').write_text('\n'.join(form)+'\n')
    files={str(p.relative_to(out)):sha(p) for p in sorted(out.rglob('*')) if p.is_file()}
    manifest={'version':'0.1','packet':'method-blinded-public-human-review','answer_count':8,
              'task_ids':sorted(set(allowed.values())),'reviewed_bundle_sha256':state['approval'],'files':files}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({'output':str(out),'answers':8,'files':len(files)+1},ensure_ascii=False))

if __name__=='__main__':main()
