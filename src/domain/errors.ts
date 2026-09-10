export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string, id: string | number) =>
  new AppError(404, 'NOT_FOUND', `${what} ${id} hittades inte`);

export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const invalid = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
