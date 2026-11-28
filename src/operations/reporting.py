"""Generate operational briefs directly from the same read-only dashboard services."""

from collections import Counter

import pandas as pd

from .backend import CHANNEL_KEYS


REPORTS = {'merchant_health': 'Merchant operational health', 'daily_network': 'Daily network activity',
           'weekly_incidents': 'Weekly incident summary', 'channel_performance': 'Channel performance',
           'unresolved': 'Unresolved incidents', 'recovery': 'Recovery summary', 'impact': 'Estimated operational impact'}


def operational_report(backend, scope, kind, start, end, *, merchant=None, channel=None):
    if kind not in REPORTS:
        raise ValueError('Unknown report kind.')
    if kind == 'merchant_health' and merchant is None:
        raise ValueError('Merchant health briefs require a merchant.')
    if kind == 'channel_performance' and channel not in CHANNEL_KEYS:
        raise ValueError('Channel performance reports require one known backend channel.')
    if kind != 'channel_performance' and channel is not None:
        raise ValueError('A channel filter belongs to the channel performance report.')
    if kind == 'daily_network' and (merchant is not None or pd.Timestamp(start) != pd.Timestamp(end)):
        raise ValueError('The daily network report covers one day in the authorized network.')
    if kind == 'weekly_incidents' and (pd.Timestamp(end) - pd.Timestamp(start)).days != 6:
        raise ValueError('Weekly reports require seven calendar dates.')
    baseline = backend.comparison(scope, start, end, merchant=merchant, channel=channel)
    activity = baseline['current']
    latest = {}
    observed = []
    daily_activity = []
    for date in pd.date_range(start, end):
        daily_activity.append(backend.activity(scope, date, date, merchant=merchant, channel=channel))
        if date < backend.epoch:
            continue
        queue = backend.queue(scope, date)
        observed.append(date.date().isoformat())
        for item in queue:
            if (merchant is None or merchant in item['merchants']) and (channel is None or channel in item['channels']):
                latest[item['id']] = item
    alerts = [row['evidence'] for row in latest.values() if row['kind'] == 'merchant_incident']
    advisories = [row for row in backend.advisories(scope, start, end)
                 if (merchant is None or merchant in row['merchants']) and (channel is None or channel == row['channel'])]
    incidents = sorted(latest.values(), key=lambda row: (-pd.Timestamp(row['as_of']).value, row['rank'], row['id']))
    if kind == 'unresolved':
        final_day = activity['end']
        incidents = [item for item in incidents if item['recovery_status'] != 'resolved' and item['as_of'] == final_day]
    elif kind == 'recovery':
        incidents = [item for item in incidents if item['recovery_status'] in {'recovering', 'resolved'}]
    elif kind == 'impact':
        incidents = [item for item in incidents if item['impact'] is not None]
    limitations = ['Amounts use the source payment unit. Rejection denominators are retained transaction records.',
                   'Collective findings describe shared symptoms. Independent technical cause requires telemetry.',
                   'Impact estimates describe potentially affected gross payment activity.',
                   'No acquiring-bank ownership mapping is available in the input.']
    if not activity['accepted_value_complete']:
        limitations.append('Observed accepted payment value covers only records with valid amounts.')
    if len(observed) < len(daily_activity):
        limitations.append('Detection coverage is shorter than activity coverage. The evidence dates show the available replay.')
    if channel:
        limitations.append('Merchant incidents may cover other channels. Channel membership supplies operational context.')
    if baseline['previous_equal_period'] is None:
        limitations.append('The preceding equal-length period has insufficient scoped coverage.')
    data = {'title': REPORTS[kind], 'kind': kind, 'period': {k: activity[k] for k in ('start', 'end')},
            'merchant_id': merchant, 'channel': channel, 'metrics': activity, 'daily_activity': daily_activity,
            'historical_comparison': baseline['previous_equal_period'], 'incidents': incidents,
            'distinct_flagged_incidents': len(alerts), 'collective_advisories': advisories,
            'criticality_counts': dict(Counter(item['criticality'] for item in incidents)),
            'limitations': limitations, 'evidence_days': observed,
            'sources': ['OperationsBackend.activity and comparison', 'OperationsBackend.queue and advisories',
                        'Frozen V2 replay and advisory V3 channel scans']}
    if hasattr(backend, 'domain_activity'):
        from .backend import Scope

        relevant = Scope(backend._merchants(scope, merchant))
        domain = backend.domain_activity(relevant, start, end, channel=channel)
        predictions = backend.candidate_predictions(relevant, start, end)
        stat = sum(row['statistical_alert'] for row in predictions)
        data['domain_rules'] = {key: val for key, val in domain.items() if key != 'correction_count'}
        data['data_quality'] = {'negative_amount_corrections': domain['correction_count']}
        data['statistical_evidence'] = {'flagged_merchant_days': stat, 'scope': 'merchant-day across all channels'}
        data['shared_domain_evidence'] = backend.domain_collective(relevant, start, end, channel=channel)
        data['sources'][-1] = f'{backend.candidate.version} candidate and advisory V3 channel scans'
    data['markdown'] = render_report(data)
    return data


def _rejection_rate(data):
    rate = data['rejection_rate']
    return f'{rate:.2%}' if rate is not None else 'unavailable at zero retained transactions'


def render_report(report):
    current, previous = report['metrics'], report['historical_comparison']
    period = (current['start'] if current['start'] == current['end'] else
              f"{current['start']} through {current['end']}")
    scope = ' · '.join(x for x in (report['merchant_id'], report['channel']) if x)
    title = f"# {report['title']}" + (f' · {scope}' if scope else '')
    lines = [title, '', f'Covered period {period} across {current["scope_merchant_count"]} authorized merchants.',
             '', '## Payment activity', '',
             f"- {current['transactions']:,} retained transactions and {current['accepted_transactions']:,} accepted payments.",
             f"- {current['observed_accepted_value']:,.2f} observed accepted payment value, with "
             f"{current['accepted_amount_coverage']:.1%} amount coverage.",
             f"- {current['rejections']:,} rejections. The retained-event rejection rate was {_rejection_rate(current)}."]
    if previous:
        lines.append(f"- The preceding period ({previous['start']} through {previous['end']}) had "
                     f"{previous['transactions']:,} transactions, {previous['observed_accepted_value']:,.2f} "
                     f"observed accepted payment value and a rejection rate of {_rejection_rate(previous)}.")
    daily = report['daily_activity']
    if len(daily) > 1:
        lines.append(f"- Daily rejection rates moved from {_rejection_rate(daily[0])} on {daily[0]['start']} "
                     f"to {_rejection_rate(daily[-1])} on {daily[-1]['start']}.")
    if 'domain_rules' in report:
        domain = report['domain_rules']
        lines += ['', '## Confirmed contactless rule evidence', '',
                  f"{domain['violation_count']:,} contactless violations totaled {domain['violation_value_dzd']:,.2f} DZD. "
                  f"The excess above the limit totaled {domain['excess_dzd']:,.2f} DZD. Confirmed economic loss is unknown.",
                  f"{domain['accepted_violations']:,} accepted and {domain['rejected_violations']:,} declined or cancelled violations.",
                  '', '## Data quality corrections', '',
                  f"{report['data_quality']['negative_amount_corrections']:,} negative amounts received sign correction.",
                  '', '## Statistical detection', '',
                  f"{report['statistical_evidence']['flagged_merchant_days']:,} candidate statistical flags across merchant-days."]
    engine = 'candidate' if 'domain_rules' in report else 'V2'
    lines += ['', '## Incidents and collective symptoms', '',
              f"{report['distinct_flagged_incidents']} distinct {engine} merchant incidents intersect the available replay. "
              f"{len(report['collective_advisories'])} V3 collective advisories were observed."]
    if report['incidents']:
        lines.append('')
    for item in report['incidents']:
        names = ', '.join(item['merchants'])
        phase = item['recovery_status'].replace('_', ' ')
        lines.append(f"- {names} · {item['criticality'].capitalize()} · {phase} as of {item['as_of']}. "
                     f"{item['responsible_role']} can act first. {item['first_action']}")
        if item['impact'] is not None:
            impact = item['impact']['cumulative']['accepted_value']
            detail = item['evidence']
            lines.append(f"  {detail['explanation']} Reference ends {detail['reference_last_date']}.")
            if impact['shortfall'] is not None:
                low, high = impact['signed_gap']['intervals']['90']
                lines.append(f"  Estimated potential accepted-value shortfall {impact['shortfall']:,.2f}. "
                             f"90% predictive interval for the signed gap {low:,.2f} to {high:,.2f}.")
            else:
                lines.append('  Accepted-value shortfall is unavailable at the observed amount coverage.')
        elif item['kind'] == 'collective_advisory':
            evidence = item['evidence']
            lines.append(f"  {evidence['channel']} · {evidence['symptom'].replace('_', ' ')} · "
                         f"{evidence['observed']} observed versus {evidence['expected']:,.2f} expected.")
    if report['collective_advisories']:
        latest = max(report['collective_advisories'], key=lambda row: (row['date'], row['collective_log_likelihood_ratio']))
        lines += ['', f"Latest collective evidence on {latest['date']} covers {latest['channel']}. "
                  f"{latest['observed']} observed versus {latest['expected']:,.2f} expected for "
                  f"{len(latest['merchants'])} selected merchants."]
    lines += ['', '## Evidence and limitations', '']
    lines.extend(f'- {limitation}' for limitation in report['limitations'])
    if report['evidence_days']:
        lines.append(f"- Incident replay dates {report['evidence_days'][0]} through {report['evidence_days'][-1]}. "
                     'Structured evidence carries the exact date, incident ID, indicator and reference.')
    return '\n'.join(lines) + '\n'
