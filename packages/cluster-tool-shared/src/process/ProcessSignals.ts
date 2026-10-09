/** POSIX signal names — the ONE spelling of a signal the harness sends to managed processes and every CLI listens for. */
export enum ProcessSignalName {
  SIGHUP = "SIGHUP",
  SIGINT = "SIGINT",
  SIGQUIT = "SIGQUIT",
  SIGABRT = "SIGABRT",
  SIGKILL = "SIGKILL",
  SIGUSR1 = "SIGUSR1",
  SIGUSR2 = "SIGUSR2",
  SIGPIPE = "SIGPIPE",
  SIGALRM = "SIGALRM",
  SIGTERM = "SIGTERM",
  SIGCHLD = "SIGCHLD",
  SIGCONT = "SIGCONT",
  SIGSTOP = "SIGSTOP",
  SIGTSTP = "SIGTSTP"
}

/** Signal name → POSIX signal number. */
export const ProcessSignals = {
  [ProcessSignalName.SIGHUP]: 1,
  [ProcessSignalName.SIGINT]: 2,
  [ProcessSignalName.SIGQUIT]: 3,
  [ProcessSignalName.SIGABRT]: 6,
  [ProcessSignalName.SIGKILL]: 9,
  [ProcessSignalName.SIGUSR1]: 10,
  [ProcessSignalName.SIGUSR2]: 12,
  [ProcessSignalName.SIGPIPE]: 13,
  [ProcessSignalName.SIGALRM]: 14,
  [ProcessSignalName.SIGTERM]: 15,
  [ProcessSignalName.SIGCHLD]: 17,
  [ProcessSignalName.SIGCONT]: 18,
  [ProcessSignalName.SIGSTOP]: 19,
  [ProcessSignalName.SIGTSTP]: 20
} as const

/** The POSIX number of a {@link ProcessSignalName}. */
export type ProcessSignalNumber = (typeof ProcessSignals)[ProcessSignalName]
