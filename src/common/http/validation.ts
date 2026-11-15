import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';

/** ValidationPipe global: payload inválido sempre vira 400 VALIDATION_ERROR. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Invalid payload',
        details: flatten(errors),
      }),
  });
}

function flatten(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map(
      (message) => `${path}: ${message}`,
    );

    return [...own, ...flatten(error.children ?? [], path)];
  });
}
