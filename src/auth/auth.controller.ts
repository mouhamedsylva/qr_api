import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import {
  ReqMeta,
  type RequestMeta,
} from '../common/decorators/request-meta.decorator';
import type { AuthUser } from '../common/types/request-context';
import { AuthService } from './auth.service';
import {
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
  SendOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';

const ONE_MINUTE = 60_000;

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: ONE_MINUTE } })
  @Post('register')
  register(@Body() dto: RegisterDto, @ReqMeta() meta: RequestMeta) {
    return this.auth.register(dto, meta);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: ONE_MINUTE } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto, @ReqMeta() meta: RequestMeta) {
    return this.auth.login(dto, meta);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: ONE_MINUTE } })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @ReqMeta() meta: RequestMeta) {
    return this.auth.refresh(dto.refreshToken, meta);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: ONE_MINUTE } })
  @HttpCode(HttpStatus.OK)
  @Post('otp/send')
  sendOtp(@CurrentUser() user: AuthUser, @Body() dto: SendOtpDto) {
    return this.auth.sendVerification(user.id, dto);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: ONE_MINUTE } })
  @HttpCode(HttpStatus.OK)
  @Post('otp/verify')
  verifyOtp(@CurrentUser() user: AuthUser, @Body() dto: VerifyOtpDto) {
    return this.auth.confirmVerification(user.id, dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: ONE_MINUTE } })
  @HttpCode(HttpStatus.OK)
  @Post('password/forgot')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: ONE_MINUTE } })
  @HttpCode(HttpStatus.OK)
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordDto, @ReqMeta() meta: RequestMeta) {
    return this.auth.resetPassword(dto, meta);
  }
}
