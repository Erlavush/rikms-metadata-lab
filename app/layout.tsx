import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "react-loading-skeleton/dist/skeleton.css";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "RIKMS Metadata Lab",
  description: "A local, human-reviewed workbench for comparing structured research metadata extraction.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
