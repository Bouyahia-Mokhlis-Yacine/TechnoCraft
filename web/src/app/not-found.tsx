import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="lost m-rise">
      <div className="big">404</div>
      <p>This page does not exist, or the merchant / alert ID is unknown.</p>
      <Link className="btn btn-primary" href="/">Back to the overview</Link>
    </div>
  );
}
