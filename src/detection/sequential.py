"""Directional count CUSUM and calibrated daily fusion."""

from dataclasses import dataclass
from datetime import datetime
from math import inf, isfinite, log, nextafter

from .calibration import RankCalibration


@dataclass(frozen=True)
class RateBank:
    ratios: tuple[float, ...]

    def __post_init__(self):
        if (not self.ratios or any(not isfinite(r) or r <= 0 or r == 1 for r in self.ratios)
                or tuple(sorted(set(self.ratios))) != self.ratios
                or not self.ratios[0] < 1 < self.ratios[-1]):
            raise ValueError('Provide unique, increasing, positive drop and surge ratios.')

    def update(self, observed, expected, previous=None, *, contiguous=True):
        if not isfinite(expected) or expected <= 0:
            raise ValueError('Poisson CUSUM requires a positive finite expectation.')
        if not isfinite(observed) or observed < 0 or observed != int(observed):
            raise ValueError('Poisson CUSUM requires a nonnegative integer count.')
        if previous is not None and previous.ratios != self.ratios:
            raise ValueError('CUSUM history belongs to a different rate bank.')
        prior = previous.values if previous else (0.,) * len(self.ratios)
        streaks = previous.streaks if previous and contiguous else (0,) * len(self.ratios)
        increments = tuple(observed * log(r) - (r - 1) * expected for r in self.ratios)
        return CountEvidence(
            self.ratios, increments,
            tuple(max(0., total + inc) for total, inc in zip(prior, increments)),
            tuple(n + 1 if inc > 0 else 0 for n, inc in zip(streaks, increments)),
        )


@dataclass(frozen=True)
class CountEvidence:
    ratios: tuple[float, ...]
    increments: tuple[float, ...]
    values: tuple[float, ...]
    streaks: tuple[int, ...]

    def peak(self, persistence=1):
        """The bank maximum and its direction, with ties broken by ratio order."""
        score, ratio = max(
            ((value, ratio) for value, ratio, streak in zip(self.values, self.ratios, self.streaks)
             if persistence == 0 or streak >= persistence),
            key=lambda arm: arm[0], default=(0., None),
        )
        return score, ('drop' if ratio < 1 else 'surge') if score > 0 else None

    def supports(self, direction):
        return any(inc > 0 for ratio, inc in zip(self.ratios, self.increments)
                   if (ratio < 1) == (direction == 'drop'))


@dataclass(frozen=True)
class CountTrack:
    """Reference-specific evidence. Gaps pause the sums and break streaks."""

    reference_version: str | None = None
    evidence: CountEvidence | None = None
    last_day: datetime | None = None
    last_valid_day: datetime | None = None

    def step(self, day, batch, daily, reference, bank):
        if self.last_day is not None and day <= self.last_day:
            raise ValueError('Replay dates must be strictly increasing.')
        if reference.as_of > day or reference.last_date >= day:
            raise ValueError('The snapshot is not strictly prior to this forecast.')
        if batch.availability(day) != 'complete' or daily is None:
            return CountTrack(self.reference_version, self.evidence, day, self.last_valid_day), None
        if (daily['reference_version'] != reference.version or daily['date'] != day.date().isoformat()
                or daily['data_availability'] != 'complete'):
            raise ValueError('Daily evidence must use the effective reference, date and batch.')
        count = daily['detectors']['transaction_count']
        if (count['method'] != 'weekday_merchant_poisson' or count['observed'] is None
                or count['expected'] is None or count['expected'] <= 0):
            return CountTrack(reference.version, None, day), None
        previous = self.evidence if self.reference_version == reference.version else None
        contiguous = self.last_valid_day is not None and (day - self.last_valid_day).days == 1
        evidence = bank.update(count['observed'], count['expected'], previous, contiguous=contiguous)
        return CountTrack(reference.version, evidence, day, day), evidence


@dataclass(frozen=True)
class Fusion:
    instant_scale: float
    sequential_scale: float
    persistence: int

    def __post_init__(self):
        if not all(isfinite(scale) and scale > 0 for scale in (self.instant_scale, self.sequential_scale)):
            raise ValueError('Fusion requires positive finite calibration scales.')
        if self.persistence < 2:
            raise ValueError('Sequential confirmation requires at least two observations.')

    def scores(self, daily, evidence):
        """Scale by ordinary upper-tail anchors and keep raw ordering beyond them."""
        instant = daily['anomaly_score']
        if instant is None:
            return None
        raw, _ = evidence.peak(0) if evidence else (0., None)
        persistent, _ = evidence.peak(self.persistence) if evidence else (0., None)
        base = instant / self.instant_scale
        return {
            'v1': instant,
            'cusum': raw if evidence else None,
            'combined': max(base, raw / self.sequential_scale),
            'managed': max(base, persistent / self.sequential_scale),
        }


def calibrated_threshold(calibration: RankCalibration, alpha):
    """Smallest float satisfying the inclusive empirical rank cutoff."""
    if alpha is None:
        return None
    allowed = sum(k / (len(calibration.scores) + 1) <= alpha
                  for k in range(1, len(calibration.scores) + 1))
    if allowed == 0:
        return None
    if alpha >= 1:
        return -inf
    return nextafter(calibration.scores[-allowed], inf)
