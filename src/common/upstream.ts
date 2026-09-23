/** Anything Supabase (PostgREST, Storage) said no to. errors.filter.ts decides what it means for the phone. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Unwraps a supabase-js `{ data, error }` result, turning the error into an UpstreamError. */
export function must<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error) throw new UpstreamError(result.error.message, result.error.code);
  return result.data;
}
