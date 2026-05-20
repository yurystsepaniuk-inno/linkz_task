import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { API_KEY_HEADER } from '../common/constants';
import { MESSAGES } from '../common/messages';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const provided = req.headers[API_KEY_HEADER];
    const expected = this.config.getOrThrow<string>('API_KEY');
    if (!provided || provided !== expected) {
      throw new UnauthorizedException(MESSAGES.auth.invalidApiKey);
    }
    return true;
  }
}
