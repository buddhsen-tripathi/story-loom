type LogLevel = "info" | "warn" | "error" | "debug"

interface LogEntry {
  level: LogLevel
  message: string
  route?: string
  durationMs?: number
  [key: string]: unknown
}

function formatLog(entry: LogEntry) {
  const timestamp = new Date().toISOString()
  const { level, message, ...meta } = entry
  const tag = level.toUpperCase().padEnd(5)
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ""
  return `[${timestamp}] ${tag} ${message}${metaStr}`
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const entry: LogEntry = { level, message, ...meta }
  const formatted = formatLog(entry)

  switch (level) {
    case "error":
      console.error(formatted)
      break
    case "warn":
      console.warn(formatted)
      break
    case "debug":
      if (process.env.NODE_ENV !== "production") {
        console.debug(formatted)
      }
      break
    default:
      console.log(formatted)
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
}
