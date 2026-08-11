export type ApiVersion = "v1" | "v2"

/**
 * The adaptor ships a v2-only API surface by default. Selecting v1 mounts the
 * legacy v1 routes (see src/api/routes/v1-legacy.ts) instead of the v2 routes.
 */
export const DEFAULT_API_VERSION: ApiVersion = "v2"
