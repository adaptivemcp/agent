/**
 * Stable process exit codes for the agent CLI. Keep these stable once published:
 * scripts and supervisors branch on them. `0` is success; the rest are distinct
 * failure classes so a caller can react without parsing stderr.
 */
export const ExitCode = {
  /** Success. */
  Ok: 0,
  /** Unexpected runtime failure. */
  Runtime: 1,
  /** Bad command-line usage (unknown flag, missing value, no server). */
  Usage: 2,
  /** Provider / catalog / model configuration error. */
  Config: 3,
  /** A tool call the host denied (approval gate). */
  ApprovalDenied: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
