import type { Metadata } from "next";
import { Fredoka, Lilita_One } from "next/font/google";
import "react-loading-skeleton/dist/skeleton.css";
import "./globals.css";

const lilitaOne = Lilita_One({
  variable: "--font-lilita-one",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

const fredoka = Fredoka({
  variable: "--font-fredoka",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "RIKMS Metadata Lab",
  description: "Upload a research paper, watch local AI extract its metadata, and validate every result.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${lilitaOne.variable} ${fredoka.variable}`}>
      <body>{children}</body>
    </html>
  );
}
