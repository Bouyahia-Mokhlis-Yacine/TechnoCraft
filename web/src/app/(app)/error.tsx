'use client';

export default function AppError({ reset }: { reset: () => void }) {
  return <section className="panel">
    <h1>Activity data unavailable</h1>
    <p>Generate a valid SATIM snapshot from the repository root, then retry.</p>
    <button type="button" className="btn btn-secondary" onClick={() => reset()}>Retry</button>
  </section>;
}
