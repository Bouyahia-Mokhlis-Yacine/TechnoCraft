import type { Metadata } from 'next';
import '@fontsource-variable/manrope';
import '@design/tokens.css';
import '@design/motion.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SATIM · Anomaly Intelligence', template: '%s · SATIM' },
  description: 'SATIM operational monitoring: merchant activity, incidents and plain-language explanations.',
};

// Runs before first paint so the saved / OS theme never flashes.
const themeScript = `try{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;document.documentElement.dataset.sidebar=localStorage.getItem('sidebar')||'open'}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
