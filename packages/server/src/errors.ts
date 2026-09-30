/** Errors whose message is safe to show to the user; `status` maps to HTTP. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Not found") => new AppError(404, "NOT_FOUND", what);
export const forbidden = (msg = "You do not have permission to do that.") => new AppError(403, "FORBIDDEN", msg);
export const badRequest = (msg: string) => new AppError(400, "BAD_REQUEST", msg);
export const conflict = (msg: string) => new AppError(409, "CONFLICT", msg);
export const unauthorized = (msg = "Please sign in.") => new AppError(401, "UNAUTHORIZED", msg);
export const paymentRequired = (msg: string) => new AppError(402, "PAYMENT_REQUIRED", msg);
export const tooMany = (retryAfterS: number) => new AppError(429, "RATE_LIMITED", `Too many attempts. Try again in ${retryAfterS} s.`);
