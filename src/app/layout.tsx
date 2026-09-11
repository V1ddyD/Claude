import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sinclair', template: '%s · Sinclair' },
  description: 'Sinclair — premium automotive.',
  robots: { index: false, follow: false }, // pre-launch
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-CA">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
