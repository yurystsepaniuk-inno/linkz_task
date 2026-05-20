import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { PG_POOL } from '../database/database.module';
import { LoginDto } from './login.dto';
import { MESSAGES } from '../common/messages';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<{ token: string }> {
    const result = await this.pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [dto.email],
    );
    const user = result.rows[0];
    if (!user) throw new UnauthorizedException(MESSAGES.auth.invalidCredentials);

    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) throw new UnauthorizedException(MESSAGES.auth.invalidCredentials);

    const token = this.jwtService.sign({ sub: user.id, email: dto.email });
    return { token };
  }
}
