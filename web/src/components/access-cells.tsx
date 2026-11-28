'use client';
// Page and action permissions as selectable cells (account forms). Each cell is a label wrapping a
// visually hidden native checkbox: a click anywhere in it toggles once, Tab moves between cells,
// Space toggles, and the form submits the same `pages` / `actions` fields as before.
import { useState } from 'react';
import { Check } from 'lucide-react';

type Item = { key: string; label: string; help?: string };

function Group({ name, legend, items, initial, kind }: { name: 'pages' | 'actions'; legend: string; items: Item[]; initial: string[]; kind: 'pages' | 'actions' }) {
  const [on, setOn] = useState(() => new Set(initial));
  const flip = (k: string) => setOn((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const count = items.filter((i) => on.has(i.key)).length;
  return (
    <fieldset className="perm">
      <legend>{legend} <span className="perm-count" aria-live="polite">· {count}/{items.length}</span></legend>
      <div className={`perm-grid perm-${kind}`}>
        {items.map((i) => (
          <label key={i.key} className="perm-cell">
            <input type="checkbox" className="perm-input" name={name} value={i.key} checked={on.has(i.key)} onChange={() => flip(i.key)} />
            <span className="perm-text"><b>{i.label}</b>{i.help && <small>{i.help}</small>}</span>
            <span className="perm-mark" aria-hidden><Check /></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function AccessCells({ pages, actions, pageLegend, actionLegend, initialPages, initialActions }:
  { pages: Item[]; actions: Item[]; pageLegend: string; actionLegend: string; initialPages: string[]; initialActions: string[] }) {
  return (
    <>
      <Group name="pages" kind="pages" legend={pageLegend} items={pages} initial={initialPages} />
      <Group name="actions" kind="actions" legend={actionLegend} items={actions} initial={initialActions} />
    </>
  );
}
