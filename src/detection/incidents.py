"""Merchant incident lifecycle and reference pinning."""

from dataclasses import dataclass, replace
from enum import StrEnum
from math import log

import pandas as pd

from .detectors import score_day
from .sequential import CountTrack, Fusion, RateBank


class Phase(StrEnum):
    NORMAL = 'normal'
    OBSERVATION = 'under_observation'
    ACTIVE = 'active_incident'
    RECOVERING = 'recovering'
    RESOLVED = 'resolved'


@dataclass(frozen=True)
class IncidentRules:
    observation_llr: float
    dismissal_llr: float
    quiet_days: int
    quiet_instant_score: float

    def __post_init__(self):
        if not 0 < self.dismissal_llr < self.observation_llr or self.quiet_days < 2:
            raise ValueError('Incident recovery requires a lower dismissal cutoff and at least two quiet days.')


@dataclass(frozen=True)
class Incident:
    merchant: str
    phase: Phase = Phase.NORMAL
    pinned_version: str | None = None
    candidate_on: str | None = None
    incident_id: str | None = None
    direction: str | None = None
    quiet: int = 0
    last_day: pd.Timestamp | None = None

    def reference_for(self, proposed, snapshots):
        """Look up the immutable snapshot retained at candidate onset."""
        if self.pinned_version is None or proposed.version == self.pinned_version:
            return proposed
        pinned = snapshots[self.pinned_version]
        if pinned.version != self.pinned_version:
            raise ValueError('Snapshot store returned a different reference version.')
        return pinned

    def step(self, day, batch, daily, evidence, reference, fusion, threshold, rules, *, domain_alert=False):
        """Return next state and the day's distinct prediction and admission decisions."""
        if self.last_day is not None and day <= self.last_day:
            raise ValueError('Replay dates must be strictly increasing.')
        if reference.as_of > day or reference.last_date >= day:
            raise ValueError('The snapshot is not strictly prior to this forecast.')
        if self.pinned_version is not None and self.pinned_version != reference.version:
            raise ValueError('An open candidate must keep its pinned reference.')

        contiguous = self.last_day is not None and (day - self.last_day).days == 1
        state = replace(self, last_day=day, quiet=self.quiet if contiguous else 0)
        if state.phase == Phase.RESOLVED:
            state = Incident(self.merchant, last_day=day)
        complete = batch.availability(day) == 'complete'
        if complete and daily is not None and (
                daily['merchant_id'] != self.merchant or daily['reference_version'] != reference.version
                or daily['date'] != day.date().isoformat() or daily['data_availability'] != 'complete'):
            raise ValueError('Daily evidence must use the effective merchant, reference, date and batch.')
        scores = fusion.scores(daily, evidence) if complete and daily is not None else None
        if scores is None:
            state = replace(state, quiet=0)
            return state, IncidentDay(None, None, state.incident_id, reference.version, False)

        date = day.date().isoformat()
        statistical_alert = threshold is not None and scores['managed'] >= threshold
        alert = statistical_alert or domain_alert
        raw, raw_direction = evidence.peak(0) if evidence else (0., None)
        _, persistent_direction = evidence.peak(fusion.persistence) if evidence else (0., None)
        instant = daily['anomaly_score']

        if state.phase == Phase.NORMAL and (alert or raw >= rules.observation_llr):
            state = replace(state, phase=Phase.OBSERVATION, pinned_version=reference.version,
                            candidate_on=date, direction=raw_direction)
        hold = state.phase != Phase.NORMAL
        if state.phase == Phase.OBSERVATION:
            if alert:
                direction = persistent_direction if statistical_alert else None
                if statistical_alert and scores['managed'] == instant / fusion.instant_scale:
                    direction = None
                    if daily['dominant_detector'] == 'transaction_count':
                        count = daily['detectors']['transaction_count']
                        direction = 'drop' if count['observed'] < count['expected'] else 'surge'
                state = replace(state, phase=Phase.ACTIVE, direction=direction, quiet=0,
                                incident_id=f'{self.merchant}:{state.candidate_on}')
            else:
                quiet = state.quiet + 1 if raw < rules.dismissal_llr and instant < rules.quiet_instant_score else 0
                state = (Incident(self.merchant, last_day=day) if quiet >= rules.quiet_days
                         else replace(state, quiet=quiet))
        elif state.phase in (Phase.ACTIVE, Phase.RECOVERING):
            count_quiet = _count_quiet(state.direction, daily, evidence)
            quiet = state.quiet + 1 if not alert and count_quiet and instant < rules.quiet_instant_score else 0
            if quiet >= rules.quiet_days:
                state = replace(state, phase=Phase.RESOLVED, pinned_version=None, quiet=quiet)
            else:
                state = replace(state, phase=Phase.RECOVERING if quiet else Phase.ACTIVE, quiet=quiet)
        return state, IncidentDay(scores, alert, state.incident_id, reference.version, hold)


def _count_quiet(direction, daily, evidence):
    if direction is None:
        return True
    if evidence is not None:
        return not evidence.supports(direction)
    # A pinned cold-start reference cannot gain support during an incident.
    count = daily['detectors']['transaction_count']
    observed = count['observed']
    if observed is None or count['interval'] is None:
        return False
    low, high = count['interval']
    return observed >= low if direction == 'drop' else observed <= high


@dataclass(frozen=True)
class IncidentDay:
    scores: dict | None
    alert: bool | None
    incident_id: str | None
    reference_version: str
    hold_for_review: bool


@dataclass(frozen=True)
class MerchantState:
    incident: Incident
    track: CountTrack = CountTrack()


@dataclass(frozen=True)
class IncidentMonitor:
    bank: RateBank
    fusion: Fusion
    threshold: float | None
    rules: IncidentRules

    @classmethod
    def from_config(cls, config):
        name = config['primary_bank']
        frozen = config['frozen']
        fusion = Fusion(**frozen['fusion'][name])
        return cls(
            RateBank(tuple(config['ratio_banks'][name])), fusion,
            frozen['policies'][f'{name}/managed']['threshold'],
            IncidentRules(log(config['observation_likelihood_ratio']), log(config['dismissal_likelihood_ratio']),
                          config['recovery_days'], fusion.instant_scale),
        )

    def step_day(self, day, batch, days, events, proposed, snapshots, states, v1, *,
                 domain_alerts=(), evidence_sink=None):
        """Score a closed date and return a new checkpoint and evidence by merchant.

        Retain proposed snapshots by version before calling. Rebuild them from the
        dated review ledger on replay. A hold means leave that date pending or
        quarantine it in the existing ledger until explicitly reviewed.
        """
        day = pd.Timestamp(day).normalize()
        rows = days.loc[days.date.eq(day)]
        if rows.merchant_id.duplicated().any():
            raise ValueError('Expected one roster row per merchant-day.')
        roster = set(rows.merchant_id)
        groups, references, previous = {}, {}, {}
        for merchant in sorted(roster | states.keys()):
            state = states.get(merchant, MerchantState(Incident(merchant)))
            reference = state.incident.reference_for(proposed, snapshots)
            references[merchant] = reference
            previous[merchant] = state
            if merchant in roster:
                groups.setdefault(reference.version, []).append(merchant)

        daily = {}
        observed = rows.loc[rows.transaction_count.notna()]
        for merchants in groups.values():
            reference = references[merchants[0]]
            results = score_day(observed.loc[observed.merchant_id.isin(merchants)],
                                events, day, batch, reference, v1)
            daily.update((result['merchant_id'], result) for result in results)
        if evidence_sink is not None:
            evidence_sink.update(daily)
        checkpoint, results = {}, {}
        for merchant, state in previous.items():
            reference = references[merchant]
            instant = daily.get(merchant)
            track, evidence = state.track.step(day, batch, instant, reference, self.bank)
            incident, result = state.incident.step(day, batch, instant, evidence, reference,
                                                  self.fusion, self.threshold, self.rules,
                                                  domain_alert=merchant in domain_alerts)
            checkpoint[merchant] = MerchantState(incident, track)
            results[merchant] = result, evidence
        return checkpoint, results
