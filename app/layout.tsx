import type { Metadata, Viewport } from 'next'
import { Toaster } from 'sonner'
import './globals.css'
import './vault.css'
export const metadata: Metadata = {
  title: 'Vault — Fault-Tolerant Distributed Object Store',
  description:
    'Persistent distributed object storage with configurable replication, verified reads, resumable uploads, consensus metadata and automatic replica repair.',
  icons: {
    icon: [
      { url: '/icon-light-32x32.png', media: '(prefers-color-scheme: light)' },
      { url: '/icon-dark-32x32.png', media: '(prefers-color-scheme: dark)' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#15181e',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans antialiased">
        {children}
        <Toaster theme="dark" position="bottom-right" richColors closeButton />
      </body>
    </html>
  )
}
