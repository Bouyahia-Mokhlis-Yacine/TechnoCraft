'use client';
import { useT } from '@/components/i18n';

export default function AppError({ reset }: { reset: () => void }) {
  const t = useT();
  return <section className="panel">
    <h1>{t('err.pageTitle')}</h1>
    <p>{t('err.pageBody')}</p>
    <button type="button" className="btn btn-secondary" onClick={() => reset()}>{t('common.retry')}</button>
  </section>;
}
