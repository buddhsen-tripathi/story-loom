"use client"

import { useCallback, useState } from "react"
import type { UseAuthResult } from "@/hooks/use-auth"

interface AuthModalProps {
  auth: UseAuthResult
}

type AuthMode = "signin" | "signup"

export function AuthModal({ auth }: AuthModalProps) {
  const [mode, setMode] = useState<AuthMode>("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)
      setLoading(true)
      try {
        if (mode === "signup") {
          await auth.signUp(email, password)
        } else {
          await auth.signIn(email, password)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Authentication failed"
        setError(message)
      } finally {
        setLoading(false)
      }
    },
    [auth, email, mode, password]
  )

  const handleGoogle = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      await auth.signInWithGoogle()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Google sign-in failed"
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [auth])

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 dark:bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-[380px] rounded-2xl border border-border bg-card p-6 shadow-xl dark:shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
        <p className="text-xs uppercase tracking-[0.22em] text-primary">Story Loom</p>
        <h2 className="mt-2 font-['Iowan_Old_Style','Baskerville','Palatino','serif'] text-2xl text-foreground">
          Sign in to save your stories
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Use email or Google to continue. Your branches and panels are stored in your account.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="auth-email" className="block text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Email
            </label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="mt-2 w-full rounded-xl border border-border bg-muted/50 px-4 py-2 text-sm text-foreground outline-none transition focus:border-primary"
            />
          </div>
          <div>
            <label htmlFor="auth-password" className="block text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              className="mt-2 w-full rounded-xl border border-border bg-muted/50 px-4 py-2 text-sm text-foreground outline-none transition focus:border-primary"
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-full bg-primary px-4 py-2 text-xs uppercase tracking-[0.18em] text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>

        <div className="mt-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-white/10" />
          <span className="text-xs uppercase tracking-[0.1em] text-muted-foreground">or</span>
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <button
          type="button"
          onClick={handleGoogle}
          disabled={loading}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-2 text-sm text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <GoogleIcon className="h-5 w-5" />
          Continue with Google
        </button>

        <button
          type="button"
          onClick={() => {
            setMode((m) => (m === "signin" ? "signup" : "signin"))
            setError(null)
          }}
          className="mt-4 w-full text-center text-sm text-muted-foreground underline hover:text-foreground"
        >
          {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  )
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}
