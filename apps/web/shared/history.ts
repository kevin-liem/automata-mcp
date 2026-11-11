/**
 * How far back a Telegram account's history is fetched when its organization
 * imports recent history only (`recent_history_only`, the flag that also limits
 * WhatsApp). WhatsApp's recent slice is WhatsApp's choice; Telegram has no such
 * slice, so the limit is a number of days, which the bridge enforces per
 * session. Shared so the server's cap and the UI's wording cannot differ.
 */
export const TELEGRAM_RECENT_HISTORY_DAYS = 90
