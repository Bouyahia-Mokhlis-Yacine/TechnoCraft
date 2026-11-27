import Link from 'next/link';
import { Suspense } from 'react';
import { getT } from '@/lib/i18n/server';

export default function NotFound() {
  return <Suspense fallback={<div className="lost" />}><Lost /></Suspense>;
}

async function Lost() {
  const t = await getT();
  return (
    <div className="lost m-rise">
      <div className="big">404</div>
      <p>{t('err.notFound')}</p>
      <Link className="btn btn-primary" href="/">{t('err.backOverview')}</Link>
    </div>
  );
}
