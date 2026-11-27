"""Fuse primary evidence and calibrate the observed maximum by inclusive rank."""

from dataclasses import dataclass

import numpy as np

PRIMARY = ('transaction_count', 'median_ticket', 'declines', 'cancellations')


def fuse(detectors):
    available = [key for key in PRIMARY if detectors[key]['score'] is not None]
    dominant = max(available, key=lambda key: detectors[key]['score'], default=None)
    return (detectors[dominant]['score'], dominant) if dominant else (None, None)


@dataclass(frozen=True)
class RankCalibration:
    scores: tuple

    @classmethod
    def fit(cls, scores):
        ordered = tuple(sorted(float(score) for score in scores if score is not None))
        if not ordered or not np.isfinite(ordered).all():
            raise ValueError('Calibration requires finite out-of-time scores.')
        return cls(ordered)

    def rank(self, score):
        if score is None:
            return None
        below = np.searchsorted(self.scores, score, side='left')
        return float((1 + len(self.scores) - below) / (1 + len(self.scores)))

