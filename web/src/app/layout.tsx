import type { Metadata } from 'next';
import '@fontsource-variable/manrope';
import '@design/tokens.css';
import '@design/motion.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SATIM · Anomaly Intelligence', template: '%s · SATIM' },
  description: 'Supervision opérationnelle SATIM : activité des commerçants, incidents et explications claires.',
};

// Runs before first paint so the saved / OS theme never flashes.
// The document language follows the pai_lang cookie (French, fr-DZ, by default).
const themeScript = `try{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;document.documentElement.dataset.sidebar=localStorage.getItem('sidebar')||'open';document.documentElement.lang=/(?:^|; )pai_lang=en/.test(document.cookie)?'en':'fr-DZ'}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr-DZ" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
