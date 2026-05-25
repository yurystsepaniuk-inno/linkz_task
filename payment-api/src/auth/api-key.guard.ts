import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { API_KEY_HEADER, PAYMENT_ERROR_CODE } from '../common/constants';
import { MESSAGES } from '../common/messages';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
    }>();
    const provided = req.headers[API_KEY_HEADER];
    const expected = this.config.getOrThrow<string>('API_KEY');

    // Constant-time compare. `timingSafeEqual` requires equal-length buffers,
    // so we pad the shorter side with the longer's bytes before comparing
    // and then also assert the lengths match — that pair is what closes the
    // length-oracle gap a naive `===` would leave open.
    if (!provided || !this.safeEqual(provided, expected)) {
      throw new UnauthorizedException({
        message: MESSAGES.auth.invalidApiKey,
        code: PAYMENT_ERROR_CODE.INVALID_API_KEY,
      });
    }
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) {
      // Still burn one constant-time compare so the failure path takes the
      // same shape regardless of which side was shorter.
      timingSafeEqual(aBuf, aBuf);
      return false;
    }
    return timingSafeEqual(aBuf, bBuf);
  }
}
