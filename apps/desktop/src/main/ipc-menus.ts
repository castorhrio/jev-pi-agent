/**
 * Menu ↔ Renderer command channel.
 *
 * The native menu cannot call a React handler directly, so it sends a typed
 * command that the Renderer reacts to. The command set is closed on purpose: an
 * unknown command is ignored rather than guessed at.
 */

export const IPC_MENU = {
  /** Main -> Renderer: run a named command */
  command: 'menu:command',
} as const;

