export type ModerationAction = 'warn' | 'hide' | 'delete';

export const MODERATION_ACTIONS: readonly ModerationAction[] = ['warn', 'hide', 'delete'];

export const MAX_WATCHED_CHANNELS = 50;

export interface GuildSettings {
  guildId: string;
  /** Default 'warn'. */
  moderationAction: ModerationAction;
  /** Default null. */
  logChannelId: string | null;
  /** Default [], max 50, no duplicates. */
  watchedChannelIds: string[];
  /** Optional Req 25; absent = disabled. */
  editRescan?: boolean;
}

export const defaultSettings = (guildId: string): GuildSettings => ({
  guildId,
  moderationAction: 'warn',
  logChannelId: null,
  watchedChannelIds: [],
});
