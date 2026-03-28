import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export const metadata: Metadata = {
  title: "Story Loom — AI Visual Story Director",
  description:
    "Create branching, cinematic visual stories powered by AI. Direct the narrative, fork timelines, and animate your panels into video.",
  keywords: ["AI", "storytelling", "visual novel", "branching narrative", "video generation", "Gemini"],
  authors: [{ name: "Story Loom" }],
  openGraph: {
    title: "Story Loom",
    description: "Direct branching visual stories with AI — then animate them into video.",
    type: "website",
  },
}

const fontSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, fontSans.variable)}
    >
      <body className="grain">
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
