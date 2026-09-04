"""Explicitly freeze public Go model metadata; never reads auth/config credentials."""
import argparse
import hashlib
import json
from pathlib import Path

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--output',type=Path,default=Path(__file__).with_name('model-catalog.json'))
    args=parser.parse_args()
    if args.output.exists():
        raise SystemExit('Snapshot already exists; choose a new output and review changes explicitly')
    catalog=json.loads(args.source.read_text())
    provider=catalog['opencode-go']
    # The source is public models metadata, not OpenCode provider config or auth.
    if not isinstance(provider.get('models'),dict) or not provider['models']:
        raise ValueError('No Go model metadata')
    args.output.write_text(json.dumps({'opencode-go':provider},indent=2,ensure_ascii=False)+'\n')
    print('Public catalog SHA256:',hashlib.sha256(args.output.read_bytes()).hexdigest())

if __name__=='__main__':
    main()
