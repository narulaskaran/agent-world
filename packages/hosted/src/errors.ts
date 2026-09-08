export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message);
    this.name = "ConflictError";
  }
}

export const isDatabaseUnavailable = (error: unknown): boolean =>
  /402|data transfer quota|connection string was provided|ECONNREFUSED|fetch failed/i.test(
    error instanceof Error ? error.message : String(error),
  );
