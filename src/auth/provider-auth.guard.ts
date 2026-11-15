import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação (seção 2 do desafio) — NO-OP.
 *
 * Decisão: autenticação não foi implementada (não pontua e não deve competir
 * com correção financeira). O desenho previsto está no ARCHITECTURE.md:
 * client-credentials OAuth2/OIDC emitido por um IdP externo (Keycloak), com
 * este guard validando o JWT (issuer, audience, assinatura via JWKS) e
 * exigindo que o `providerId` do corpo seja igual ao claim do token.
 *
 * Aplicado nos controllers de negócio; health e métricas ficam abertos.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
