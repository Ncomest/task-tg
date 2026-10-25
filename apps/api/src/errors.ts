export class HttpError extends Error {
  constructor(public statusCode: number, public code: string) { super(code); }
}
