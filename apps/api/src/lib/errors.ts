export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = (msg = 'Oturum açmanız gerekiyor.') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Bu işlem için yetkiniz yok.', code = 'FORBIDDEN') => new AppError(403, code, msg);
export const notFound = (msg = 'Kayıt bulunamadı.') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string, code = 'CONFLICT') => new AppError(409, code, msg);
export const badRequest = (msg: string, code = 'BAD_REQUEST', details?: unknown) => new AppError(400, code, msg, details);
export const unavailable = (msg: string, code: string, details?: unknown) => new AppError(503, code, msg, details);
