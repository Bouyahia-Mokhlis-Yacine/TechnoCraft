"""Optional, separate amount-policy audit. Prints aggregate evidence only."""

import argparse
import json
import os
from pathlib import Path

import pandas as pd

from src.data.mentor_rules import prepare_candidate
from src.data.preprocessing import KEYS
from src.detection.mentor_candidate import load_candidate

from .replay import INPUTS, ROOT, check_fingerprints


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--split', choices=('train', 'test'), default='train')
    parser.add_argument('--data-dir', type=Path, default=Path(os.environ.get('SATIM_DATA_DIR', ROOT)))
    args = parser.parse_args()
    check_fingerprints(args.data_dir, INPUTS)
    policy = load_candidate(ROOT)
    roster = 'y_train_labels.csv' if args.split == 'train' else 'y_pred_template.csv'
    raw = pd.read_csv(args.data_dir / f'X_{args.split}_transactions.csv', dtype={'masked_pan': 'string'})
    days, events, _ = prepare_candidate(raw, pd.read_csv(args.data_dir / roster, usecols=KEYS),
                                        limit=policy.contactless_limit_dzd)
    print(json.dumps({
        'policy': policy.version, 'purpose': 'opt-in monetary audit', 'split': args.split,
        'retained_events': len(events), 'sign_corrected_events': int(events.amount_corrected.sum()),
        'contactless_limit_events': int(events.is_contactless_violation.sum()),
        'known_accepted_value_dzd': float(days.accepted_amount.sum()),
        'incomplete_accepted_value_days': int(days.accepted_count.ne(days.valid_accepted_amount_count).sum()),
    }, indent=2))


if __name__ == '__main__':
    main()
