"""Build and execute the reproducible research views from cached evidence."""

from pathlib import Path

import nbformat
from nbclient import NotebookClient

from .archive import ROOT

HEADER = """from pathlib import Path
import json
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('module://matplotlib_inline.backend_inline')
import matplotlib.pyplot as plt
from IPython.display import display

root = Path.cwd()
if not (root / 'config' / 'live_monitoring.v1.json').exists():
    root = root.parent
evidence = root / 'reports' / 'live_monitoring'
figures = evidence / 'figures'
figures.mkdir(exist_ok=True)
plt.rcParams.update({'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False,
                     'axes.grid': True, 'grid.alpha': .2, 'figure.dpi': 110})

def save(fig, name):
    fig.tight_layout()
    fig.savefig(figures / (name + '.png'), dpi=140, bbox_inches='tight')
    display(fig)
    plt.close(fig)
"""

NOTEBOOKS = {
    "31_intraday_activity_diagnostics": (
        "Intraday activity diagnostics",
        "The first 21 ordinary training dates fit the reference. These charts describe the 14 later ordinary dates. Each zero is in the explicit archive calendar. One-minute means distribute each five-minute expectation uniformly.",
        """d = pd.read_csv(evidence / 'temporal_diagnostics.csv')
levels = ['network', 'channel', 'merchant', 'category', 'merchant-channel']
fig, axes = plt.subplots(1, 2, figsize=(11, 4))
for kind in levels:
    means = d[d.scope.eq(kind)].groupby('minutes').mean(numeric_only=True)
    axes[0].plot(means.index, means.empty_fraction, 'o-', label=kind)
    axes[1].plot(means.index, means.mean_expected, 'o-', label=kind)
axes[0].set(ylabel='Fraction of empty intervals', xlabel='Interval (minutes)', xscale='log')
axes[1].set(ylabel='Mean expected transactions', xlabel='Interval (minutes)', xscale='log', yscale='log')
axes[0].legend(frameon=False, fontsize=8)
save(fig, 'exposure_and_empty_intervals')

five = d[(d.minutes == 5) & (d.scope == 'network')].iloc[0]
hourly = np.array(json.loads(five.time_bin_means)).reshape(24, 12).sum(axis=1)
fig, ax = plt.subplots(figsize=(8, 3))
ax.bar(np.arange(24), hourly, color='#178f82')
ax.set(xlabel='Hour on archive clock', ylabel='Mean transactions per hour', title='Network activity by hour')
save(fig, 'intraday_network_profile')
""",
    ),
    "32_intraday_probabilistic_detection": (
        "Intraday probability and sequential evidence",
        "Distribution selection uses chronological prediction as evidence. The serving calibration is a predeclared Poisson-based challenger. CUSUM consumes fresh five-minute increments, and empirical warning thresholds account for repeated scope and interval checks.",
        """p = pd.read_csv(evidence / 'predictive_comparison.csv')
cols = ['minutes', 'scope', 'profile', 'distribution', 'nll', 'crps', 'coverage90']
display(p.loc[p.minutes.eq(5), cols].sort_values('nll').groupby('scope').head(3).round(4))

from src.live_monitoring.archive import Archive
from src.live_monitoring.evaluation import locked_thresholds
from src.live_monitoring.replay import Replay
a = Archive()
tape = a.tape('2026-10-03', '2026-10-03', 'backlog')
replay = Replay(a, tape, locked_thresholds(a), close_daily=False)
traces = []
for i in range(tape.size):
    replay.advance()
    traces.append(replay.signals.cusum[a.reference.index['channel','pos']].copy())
points = pd.DataFrame(replay.snapshot(('channel','pos'))['points'])
points['time'] = pd.to_datetime(points['time'])
fig, axes = plt.subplots(2, 1, figsize=(10, 5), sharex=True)
axes[0].plot(points.time, points.cumulative, label='Observed', color='#178f82')
axes[0].plot(points.time, points.cumulative_expected, '--', label='Expected', color='#5479bf')
axes[0].set(ylabel='Transactions')
axes[0].legend(frameon=False)
axes[1].plot(points.time, np.asarray(traces)[:, 0], label='Downward')
axes[1].plot(points.time, np.asarray(traces)[:, 1], label='Upward')
axes[1].set(xlabel='Simulated event time', ylabel='CUSUM evidence')
for ax in axes:
    ax.axvspan(tape.scenario.onset, tape.scenario.end, color='#eaa054', alpha=.28)
axes[1].legend(frameon=False)
save(fig, 'same_day_backlog_and_cusum')
""",
    ),
    "33_live_collective_detection": (
        "Live collective detection",
        "The directional count scan and rejection subset scan use the existing likelihood functions. Each plotted point is the strongest subset for that channel and symptom at a finalized 15-minute close. The orange region is injected truth.",
        """from src.live_monitoring.archive import Archive, BIN
from src.live_monitoring.detection import Signals
from src.live_monitoring.evaluation import locked_thresholds
a = Archive()
t = a.tape('2026-10-03','2026-10-03','collective')
s = Signals(t)
rows = []
for i in range(t.size):
    _, scans, *_ = s.tick(i)
    for row in scans:
        if row['scope'] == ('channel','ecommerce'):
            rows.append({**row, 'time': t.start + (i+1)*BIN})
rows = pd.DataFrame(rows)
fig, axes = plt.subplots(2, 1, figsize=(9, 5), sharex=True)
for symptom, group in rows.groupby('symptom'):
    axes[0].scatter(group.time, group.score, s=14, label=symptom)
drops = rows[rows.symptom.eq('Shared activity shortfall')]
axes[1].scatter(drops.time, drops.observed, s=15, label='Observed')
axes[1].scatter(drops.time, drops.expected, s=15, marker='x', label='Expected')
axes[0].axhline(locked_thresholds(a)['collective'], color='#ab3c34', linestyle='--', label='Frozen cutoff')
for ax in axes:
    ax.axvspan(t.scenario.onset, t.scenario.end, color='#eaa054', alpha=.28)
    ax.legend(frameon=False)
axes[0].set(ylabel='Likelihood evidence')
axes[1].set(xlabel='Simulated event time', ylabel='Subset transactions')
save(fig, 'collective_example')
""",
    ),
    "34_live_detection_robustness": (
        "Chronological evaluation and robustness",
        "The heatmap covers the predeclared POS magnitude/duration grid. Delay is conditional on an incremental hit. Archived merchant-day labels are reported separately with no inferred intraday labels.",
        """s = pd.read_csv(evidence / 'synthetic_cases.csv')
ordinary = json.loads((evidence / 'ordinary_workload.json').read_text())
grid = s[s.method.eq('selected') & s.family.eq('drop')]
p = grid.pivot_table(index='minutes', columns='magnitude', values='hit').sort_index()
fig, ax = plt.subplots(figsize=(7, 4))
m = ax.imshow(p, vmin=0, vmax=1, cmap='YlGn')
ax.set(xticks=range(len(p.columns)), xticklabels=[f'{x:.0%}' for x in p.columns],
       yticks=range(len(p.index)), yticklabels=p.index, xlabel='Injected reduction', ylabel='Duration (minutes)')
fig.colorbar(m, ax=ax, label='Paired event recall')
for i in range(len(p.index)):
    for j in range(len(p.columns)):
        ax.text(j, i, f'{p.iloc[i,j]:.0%}', ha='center', va='center')
save(fig, 'pos_duration_and_intensity')

fig, axes = plt.subplots(1, 2, figsize=(11, 4))
burden = pd.Series(ordinary['method_warning_days']).sort_values()
burden.plot.barh(ax=axes[0], color='#178f82')
axes[0].set(xlabel='Untouched ordinary warning days (14 available)')
delays = s[s.hit].groupby('method').delay
groups = [(name, x.dropna().tolist()) for name, x in delays if x.notna().any()]
if groups:
    axes[1].boxplot([x for _, x in groups], tick_labels=[k for k, _ in groups], vert=False)
axes[1].set(xlabel='Minutes to first incremental warning')
save(fig, 'workload_and_detection_delay')
display(pd.read_json(evidence / 'development_overlap.json'))
external = evidence / 'external_aiops.json'
if external.exists():
    display(pd.read_json(external).groupby('mode')[['events','hits','ordinary_points','ordinary_warning_points']].sum())
""",
    ),
    "35_streaming_performance": (
        "Local streaming performance",
        "The accelerated run advances all event-time ticks. Scoring, collective scan overhead, daily closure, API response and browser display are different latency measurements. Results describe this specific Windows host and workload.",
        """m = json.loads((evidence / 'performance.json').read_text())
display(pd.Series(m, name='Measured value').to_frame())
fig, ax = plt.subplots(figsize=(8, 3))
latencies = {'Scoring tick · median': m['median_scoring_tick_ms'],
             'Tick with scan · median': m['median_tick_with_collective_ms'],
             'All intraday ticks · p95': m['p95_tick_ms'],
             'Daily closure tick': m['closing_tick_ms']}
ax.barh(list(latencies), list(latencies.values()), color=['#178f82']*3 + ['#5479bf'])
ax.set(xlabel='End-to-end compute time (milliseconds, log scale)', xscale='log')
save(fig, 'streaming_latency')
browser = evidence / 'browser_verification.json'
if browser.exists():
    display(pd.Series(json.loads(browser.read_text()), name='Chromium verification').to_frame())
""",
    ),
}


def build():
    directory = ROOT / "notebooks"
    directory.mkdir(exist_ok=True)
    for name, (title, description, code) in NOTEBOOKS.items():
        notebook = nbformat.v4.new_notebook(
            cells=[nbformat.v4.new_markdown_cell(f"# {title}\n\n{description}"),
                   nbformat.v4.new_code_cell(HEADER), nbformat.v4.new_code_cell(code)],
            metadata={"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}},
        )
        NotebookClient(notebook, timeout=180, resources={"metadata": {"path": str(ROOT)}}).execute()
        nbformat.write(notebook, Path(directory) / f"{name}.ipynb")


if __name__ == "__main__":
    build()
