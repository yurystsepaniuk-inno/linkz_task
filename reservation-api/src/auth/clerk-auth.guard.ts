import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyToken } from '@clerk/backend';
import { Request } from 'express';
import { MESSAGES } from '../common/messages';

/**
 * Request shape after a successful guard pass. The Clerk user id (`sub`) is
 * attached here so controllers never re-parse the token.
 */
export interface AuthenticatedRequest extends Request {
  auth: { userId: string };
}

const BEARER_PREFIX = 'Bearer ';

/**
 * `verifyToken` rejects with these signals when the failure is upstream
 * (Clerk JWKs unreachable) rather than the token itself being invalid.
 * Matching by name and message substring because @clerk/backend does not
 * export a typed error hierarchy.
 */
function isUpstreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return true;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('jwks') ||
    msg.includes('unable to fetch')
  );
}

/**
 * Verifies a Clerk-issued session token on every protected request.
 *
 * The token is a short-lived (~60s) JWT that the Clerk frontend SDK refreshes
 * silently from the long-lived (up to 90-day) session. We never issue or store
 * a 90-day token ourselves: `verifyToken` rejects anything past `exp`, so a
 * leaked token is useless within a minute. This is the access/refresh split.
 */
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly logger = new Logger(ClerkAuthGuard.name);

  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException(MESSAGES.auth.missingToken);
    }

    const token = header.slice(BEARER_PREFIX.length);

    try {
      const payload = await verifyToken(token, {
        secretKey: this.config.getOrThrow<string>('CLERK_SECRET_KEY'),
      });
      (req as AuthenticatedRequest).auth = { userId: payload.sub };
      return true;
    } catch (err) {
      // Distinguish "Clerk says this token is bad" (401) from "we couldn't
      // reach Clerk at all" (503). Collapsing both to 401 caused two real
      // problems: legitimate users got signed out on every Clerk hiccup, and
      // the SLO error budget never recorded the actual cause as our outage.
      if (isUpstreamError(err)) {
        this.logger.error(
          `Clerk verification upstream error: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException(MESSAGES.auth.verifierUnavailable);
      }
      throw new UnauthorizedException(MESSAGES.auth.invalidToken);
    }
  }
}
