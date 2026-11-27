// Loading skeletons that mirror each page's real layout: same header, filter bar, grids, panel
// sizes and dark hero, so content fills in place instead of jumping. Heights are the measured
// heights of the real panels at 1366 px; they stretch naturally on other widths.
const css = (o: Record<string, string | number>) => o as React.CSSProperties;

const Bar = ({ w = '100%', h = 12, r }: { w?: number | string; h?: number; r?: number }) => <span className="skeleton sk" style={css({ width: w, height: h, ...(r ? { borderRadius: r } : {}) })} />;

function Header({ title, crumbs = false, back = crumbs, actions = 0, tall = false, titleW }: { title?: string; crumbs?: boolean; back?: boolean; actions?: number; tall?: boolean; titleW?: number }) {
  return (
    <header className="page-header sk-header">
      <div className="page-title">
        {crumbs && <div className="crumbs"><Bar w={180} h={12} /></div>}
        <div className="title-row">
          {back && <span className="back-btn sk-back" aria-hidden />}
          {title ? <h1>{title}</h1> : <Bar w={titleW ?? (tall ? 420 : 320)} h={30} r={8} />}
        </div>
      </div>
      <div className="row">
        {Array.from({ length: actions }, (_, i) => <Bar key={i} w={actions > 1 && i === 0 ? 154 : 120} h={42} r={10} />)}
        <div className="header-actions"><Bar w={118} h={12} /><span className="sk-icon"><Bar w={20} h={20} r={6} /></span><span className="sk-icon"><Bar w={20} h={20} r={6} /></span></div>
      </div>
    </header>
  );
}

function Filters({ fields }: { fields: number }) {
  return (
    <div className="panel filters sk-filters" aria-hidden>
      {Array.from({ length: fields }, (_, i) => <div key={i} className="field"><Bar w={56} h={10} /><Bar h={38} r={10} /></div>)}
      <Bar w={56} h={14} />
    </div>
  );
}

/** A card with a title (and optional subtitle) and a body that fills the measured height. */
function Panel({ h, sub = true, body = 'block', className = '', rows = 4 }: { h: number; sub?: boolean; body?: 'block' | 'rows' | 'bars' | 'lines' | 'tiles' | 'pie' | 'none'; className?: string; rows?: number }) {
  return (
    <section className={`panel sk-panel ${className}`} style={{ minHeight: h }}>
      <div className="panel-head"><div className="sk-head"><Bar w={170} h={20} r={6} />{sub && <Bar w={240} h={11} />}</div></div>
      {body === 'block' && <Bar h={Math.max(40, h - 120)} r={10} />}
      {body === 'rows' && <div className="sk-rows">{Array.from({ length: rows }, (_, i) => <Bar key={i} h={48} r={10} />)}</div>}
      {body === 'bars' && <div className="sk-bars">{Array.from({ length: rows }, (_, i) => <div key={i} className="sk-bar"><Bar w={`${40 + ((i * 23) % 40)}%`} h={11} /><Bar h={8} r={99} /></div>)}</div>}
      {body === 'lines' && <div className="sk-lines">{Array.from({ length: rows }, (_, i) => <Bar key={i} w={`${60 + ((i * 17) % 35)}%`} h={14} />)}</div>}
      {body === 'tiles' && <div className="sk-tiles">{Array.from({ length: rows }, (_, i) => <Bar key={i} h={62} r={10} />)}</div>}
      {body === 'pie' && <div className="sk-pie"><Bar w={220} h={220} r={999} /><div className="sk-rows">{Array.from({ length: rows }, (_, i) => <Bar key={i} h={16} />)}</div></div>}
    </section>
  );
}

function Kpis({ n, cols, h }: { n: number; cols: 'three' | 'four'; h: number }) {
  return (
    <div className={`kpi-grid ${cols}`}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={`kpi sk-kpi${i === 0 ? ' hero' : ''}`} style={{ minHeight: h }}>
          <Bar w={48} h={48} r={10} /><span />
          <span className="sk-kpi-text"><Bar w="55%" h={13} /><Bar w="70%" h={30} r={8} /><Bar w="45%" h={10} /></span>
        </div>
      ))}
    </div>
  );
}

function Hero({ h }: { h: number }) {
  return (
    <section className="story sk-hero" style={{ minHeight: h }} aria-hidden>
      <Bar w={240} h={12} />
      <Bar w={160} h={56} r={10} />
      <Bar h={12} r={99} />
      <div className="sk-figs">{[0, 1, 2, 3].map((i) => <span key={i}><Bar w={64} h={28} r={6} /><Bar w={80} h={10} /></span>)}</div>
    </section>
  );
}

function Table({ cols, rows }: { cols: number[]; rows: number }) {
  return (
    <div className="panel table-panel sk-table" aria-hidden>
      <div className="sk-tr sk-th" style={css({ gridTemplateColumns: cols.map((w) => `${w}fr`).join(' ') })}>{cols.map((w, i) => <Bar key={i} w="50%" h={10} />)}</div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="sk-tr" style={css({ gridTemplateColumns: cols.map((w) => `${w}fr`).join(' ') })}>
          {cols.map((w, i) => <Bar key={i} w={`${55 + ((r * 7 + i * 13) % 40)}%`} h={12} />)}
        </div>
      ))}
    </div>
  );
}

const Note = () => <Bar w={150} h={14} />;
const wrap = (children: React.ReactNode) => <div className="sk-page" aria-busy="true" aria-label="Loading">{children}</div>;

/* ── one skeleton per page ─────────────────────────────────────────── */
export const OverviewSkeleton = () => wrap(<>
  <Header title="Network overview" />
  <Filters fields={5} />
  <div className="ov">
    <div className="stack"><Kpis n={6} cols="three" h={206} /><Panel h={368} sub={false} body="block" /><Panel h={224} body="tiles" rows={3} className="sk-signals" /></div>
    <div className="stack"><Panel h={625} sub={false} body="pie" rows={6} className="tinted" /><Panel h={338} body="block" /><Panel h={288} body="block" /></div>
  </div>
</>);

export const ListSkeleton = ({ title, fields, cols, rows = 8, actions = 1 }: { title: string; fields: number; cols: number[]; rows?: number; actions?: number }) => wrap(<>
  <Header title={title} actions={actions} />
  <Filters fields={fields} />
  <Table cols={cols} rows={rows} />
  <Note />
</>);

export const IncidentSkeleton = () => wrap(<>
  <Header crumbs actions={1} tall />
  <div className="detail-grid">
    <div className="stack"><Hero h={316} /><Panel h={329} sub={false} body="rows" rows={3} /><Panel h={247} body="block" /><Panel h={228} sub={false} body="block" /></div>
    <div className="stack"><Panel h={331} body="block" /><Panel h={311} sub={false} body="rows" rows={3} /><Panel h={208} body="bars" rows={2} /></div>
  </div>
</>);

export const AlertSkeleton = () => wrap(<>
  <Header title="Alert explanation" crumbs actions={1} />
  <div className="detail-grid">
    <div className="stack"><Hero h={292} /><Panel h={185} sub={false} body="lines" rows={3} /><Panel h={284} sub={false} body="bars" rows={2} /><Panel h={329} sub={false} body="rows" rows={3} /></div>
    <div className="stack"><Panel h={345} body="block" /><Panel h={367} body="bars" rows={5} /><Panel h={268} body="block" /></div>
  </div>
</>);

export const AdvisorySkeleton = () => wrap(<>
  <Header crumbs tall />
  <div className="detail-grid">
    <div className="stack"><Hero h={347} /><Panel h={532} body="rows" rows={2} /><Panel h={474} body="tiles" rows={8} className="sk-chips" /></div>
    <div className="stack"><Panel h={560} body="tiles" rows={30} className="sk-mtiles" /><Panel h={712} body="block" /></div>
  </div>
</>);

export const IntelligenceSkeleton = () => wrap(<>
  <Header title="Network intelligence" />
  <section className="panel sk-panel" style={{ minHeight: 128 }}><div className="sk-head"><Bar w={110} h={11} /><Bar w={360} h={20} r={6} /><Bar w={300} h={12} /></div></section>
  <div className="sk-head"><Bar w={220} h={20} r={6} /><Bar w={340} h={11} /></div>
  <section className="panel sk-panel" style={{ minHeight: 166 }}><div className="sk-head"><Bar w={240} h={11} /><Bar w={420} h={20} r={6} /><Bar w={360} h={10} r={99} /></div></section>
  <section className="panel sk-panel" style={{ minHeight: 122 }}><div className="sk-head"><Bar w={220} h={11} /><Bar w={340} h={20} r={6} /><Bar w={300} h={10} r={99} /></div></section>
</>);

export const MerchantSkeleton = () => wrap(<>
  <Header crumbs actions={3} titleW={380} />
  <Kpis n={4} cols="four" h={204} />
  <Panel h={347} sub={false} body="block" />
  <div className="ov">
    <div className="stack"><Panel h={417} body="tiles" rows={6} className="sk-health" /><Panel h={176} body="rows" rows={1} /></div>
    <div className="stack"><Panel h={256} body="block" /><Panel h={597} sub={false} body="pie" rows={6} className="tinted" /><Panel h={289} sub={false} body="bars" rows={4} /></div>
  </div>
</>);

export const ReportsSkeleton = () => wrap(<>
  <Header title="Reports" actions={2} />
  <Filters fields={2} />
  <article className="panel report sk-panel" style={{ minHeight: 848 }}>
    <div className="sk-head"><Bar w={200} h={11} /><Bar w={460} h={28} r={8} /><Bar w={280} h={12} /></div>
    <div className="report-kpis">{[0, 1, 2, 3].map((i) => <Bar key={i} h={96} r={10} />)}</div>
    <Bar w={220} h={16} /><div className="sk-rows">{[0, 1].map((i) => <Bar key={i} h={44} r={10} />)}</div>
    <Bar w={200} h={16} /><div className="sk-rows">{[0, 1].map((i) => <Bar key={i} h={44} r={10} />)}</div>
  </article>
</>);

export const DataSkeleton = () => wrap(<>
  <Header title="Data & runs" />
  <Panel h={197} body="tiles" rows={7} className="sk-pipeline" />
  <div className="ov">
    <div className="stack"><Panel h={416} sub={false} body="bars" rows={6} /><Panel h={322} body="block" /><Panel h={342} body="block" /></div>
    <div className="stack"><Panel h={141} body="none" /></div>
  </div>
</>);

export const AssistantSkeleton = () => wrap(
  <div className="assistant-page">
    <header className="page-header sk-header"><div className="title-row"><Bar w={150} h={16} /></div><div className="header-actions"><Bar w={120} h={12} /><Bar w={28} h={28} r={8} /><Bar w={28} h={28} r={8} /></div></header>
    <div className="chat sk-chat">
      <aside className="chat-rail"><Bar h={40} r={10} /><Bar w={64} h={10} /><div className="sk-rows">{[150, 190, 120, 170, 140].map((w, i) => <Bar key={i} w={w} h={14} />)}</div></aside>
      <div className="chat-main is-empty"><div className="sk-chat-mid"><Bar w={320} h={30} r={8} /><Bar w={280} h={12} /><Bar w="100%" h={60} r={28} /><div className="sk-tiles">{[0, 1, 2, 3, 4, 5].map((i) => <Bar key={i} h={56} r={14} />)}</div></div></div>
    </div>
  </div>
);

export const SimulatorSkeleton = () => wrap(<>
  <Header title="Simulator" />
  <Panel h={639} body="block" />
  <Panel h={541} body="block" />
</>);
