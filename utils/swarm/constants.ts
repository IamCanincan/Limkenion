export const TEAM_LEAD_NAME = 'team-lead'
export const SWARM_SESSION_NAME = 'limkenion-swarm'
export const SWARM_VIEW_WINDOW_NAME = 'swarm-view'
export const TMUX_COMMAND = 'tmux'
export const HIDDEN_SESSION_NAME = 'limkenion-hidden'

/**
 * Gets the socket name for external swarm sessions (when user is not in tmux).
 * Uses a separate socket to isolate swarm operations from user's tmux sessions.
 * Includes PID to ensure multiple Limkenion instances don't conflict.
 */
export function getSwarmSocketName(): string {
  return `limkenion-swarm-${process.pid}`
}

/**
 * Environment variable to override the command used to spawn teammate instances.
 * If not set, defaults to process.execPath (the current Limkenion binary).
 * This allows customization for different environments or testing.
 */
export const TEAMMATE_COMMAND_ENV_VAR = 'LIMKENION_TEAMMATE_COMMAND'


